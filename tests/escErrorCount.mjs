import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "ulog-esc-errorcount-"));
try {
  await build({ entryPoints: ["src/escErrorCount.ts", "src/ulogData.ts"], outdir: dir,
    bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" } });
  const { decodeCanCounters, errorCountTypeNames } = await import(pathToFileURL(join(dir, "escErrorCount.mjs")));
  const { plottableFields, addDerivedCanCounterColumns, addDerivedRpyColumns } =
    await import(pathToFileURL(join(dir, "ulogData.mjs")));

  // One sample per type 0..9, then packed with other values, then invalid counts.
  const packed = (tec, rec) => tec * 65536 + rec;
  const counts = Float64Array.from([7, 7, 7, 7, 7, 7, 7, 7, packed(128, 3), 7, packed(65535, 65535), 12, NaN, -1, 2 ** 32]);
  const types = Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 8, 200, 8, 5, 6]);
  const { tec, rec } = decodeCanCounters(counts, types);
  const expectTec = { 5: 7, 8: 128, 10: 65535 }, expectRec = { 6: 7, 8: 3, 10: 65535 };
  for (let i = 0; i < counts.length; i++) {
    assert.ok(Object.is(tec[i], expectTec[i] ?? NaN), `tec[${i}] = ${tec[i]}`);
    assert.ok(Object.is(rec[i], expectRec[i] ?? NaN), `rec[${i}] = ${rec[i]}`);
  }
  assert.deepEqual(errorCountTypeNames.names[8], [8, "CAN_TEC_REC_PACKED"]);

  const scalar = (name, type) => ({ name, type, isComplex: false });
  const report = (withType) => ({ name: "esc_report", fields: [
    scalar("timestamp", "uint64_t"), scalar("esc_errorcount", "uint32_t"),
    ...(withType ? [scalar("esc_errorcount_type", "uint8_t")] : []), scalar("esc_rpm", "int32_t"),
  ] });
  const subscription = { name: "esc_status", fields: [
    scalar("timestamp", "uint64_t"), { name: "esc", type: "esc_report", arrayLength: 2, isComplex: true },
  ] };

  // Fork log: the type is logged, so the count is annotated and TEC/REC are offered per ESC.
  const typed = new Map([["esc_report", report(true)]]);
  const fields = plottableFields(subscription, typed);
  assert.equal(fields.find((f) => f.name === "esc[1].esc_errorcount").valueNames, undefined);
  assert.deepEqual(fields.find((f) => f.name === "esc[1].esc_errorcount_type").valueNames, errorCountTypeNames);
  assert.deepEqual(fields.filter((f) => f.derived).map((f) => [f.name, f.derived.group]), [
    ["esc[0].derived_can_tec", "esc[0]"], ["esc[0].derived_can_rec", "esc[0]"],
    ["esc[1].derived_can_tec", "esc[1]"], ["esc[1].derived_can_rec", "esc[1]"],
  ]);
  const data = { times: Float64Array.from([0, 1]), columns: new Map([
    ["esc[0].esc_errorcount", Float64Array.from([5, packed(9, 4)])],
    ["esc[0].esc_errorcount_type", Float64Array.from([0, 8])],
    ["esc[1].esc_errorcount", Float64Array.from([0, 0])],
    ["esc[1].esc_errorcount_type", Float64Array.from([0, 0])],
  ]) };
  addDerivedCanCounterColumns(addDerivedRpyColumns(data, subscription, typed), subscription, typed);
  assert.deepEqual([...data.columns.get("esc[0].derived_can_tec")], [NaN, 9]);
  assert.deepEqual([...data.columns.get("esc[0].derived_can_rec")], [NaN, 4]);
  assert.ok(data.columns.get("esc[1].derived_can_tec").every(Number.isNaN));
  assert.equal(data.columns.get("esc[0].esc_errorcount")[1], packed(9, 4)); // raw logged data preserved

  // Upstream log: no type field, so nothing is annotated, derived or added.
  const untyped = new Map([["esc_report", report(false)]]);
  const plain = plottableFields(subscription, untyped);
  assert.deepEqual(plain.map((f) => f.name),
    ["esc[0].timestamp", "esc[0].esc_errorcount", "esc[0].esc_rpm", "esc[1].timestamp", "esc[1].esc_errorcount", "esc[1].esc_rpm"]);
  assert.ok(plain.every((f) => !f.derived && !f.valueNames));
  const plainData = { times: Float64Array.from([0]), columns: new Map([["esc[0].esc_errorcount", Float64Array.from([5])]]) };
  addDerivedCanCounterColumns(plainData, subscription, untyped);
  assert.deepEqual([...plainData.columns.keys()], ["esc[0].esc_errorcount"]);
  // A same-named field outside esc_report is not interpreted either.
  const other = new Map([["esc_report", { ...report(true), name: "other_report" }]]);
  assert.ok(plottableFields({ ...subscription, fields: [{ ...subscription.fields[1], type: "esc_report" }] }, other)
    .every((f) => !f.derived && !f.valueNames));

  console.log("ESC error count tests passed: decoding per type, schema gate, derived columns.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
