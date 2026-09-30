import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "ulog-rpy-"));
try {
  await build({ entryPoints: ["src/quaternion.ts", "src/ulogData.ts"], outdir: dir,
    bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" } });
  const { quaternionToRpy: convert, quaternionSource } = await import(pathToFileURL(join(dir, "quaternion.mjs")));
  const { plottableFields, addDerivedRpyColumns } = await import(pathToFileURL(join(dir, "ulogData.mjs")));
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
  const half = Math.PI / 8;
  for (let axis = 0; axis < 3; axis++) {
    const q = [Math.cos(half), 0, 0, 0];
    q[axis + 1] = Math.sin(half);
    const result = convert(...q);
    result.forEach((v, i) => near(v, i === axis ? Math.PI / 4 : 0));
    convert(...q.map((v) => -v)).forEach((v, i) => near(v, result[i]));
    convert(...q.map((v) => v * 1.005)).forEach((v, i) => near(v, result[i]));
  }
  // Combined ZYX rotation: catches component order/sign mistakes beyond single-axis tests.
  const r = 0.3, p = -0.4, y = 1.2;
  const cr = Math.cos(r / 2), sr = Math.sin(r / 2), cp = Math.cos(p / 2), sp = Math.sin(p / 2), cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  convert(cr*cp*cy+sr*sp*sy, sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy)
    .forEach((v, i) => near(v, [r, p, y][i]));
  for (const q of [[0,0,0,0], [2,0,0,0], [NaN,0,0,0], [Infinity,0,0,0]]) {
    assert.ok(convert(...q).every(Number.isNaN));
  }
  for (const sign of [-1, 1]) {
    const result = convert(Math.SQRT1_2, 0, sign * Math.SQRT1_2, 0);
    assert.ok(Number.isNaN(result[0]) && Number.isNaN(result[2]));
    near(result[1], sign * Math.PI / 2);
  }
  const fields = (name, type = "float", arrayLength = 4, frame = true) => plottableFields({ name,
    fields: [{name: quaternionSource(name) ?? "q", type, arrayLength, isComplex: false},
      ...(frame ? [{name: "pose_frame", type: "uint8_t", isComplex: false}] : [])] }, new Map());
  for (const topic of ["vehicle_attitude", "estimator_attitude", "vehicle_attitude_setpoint", "vehicle_visual_odometry"]) {
    assert.equal(fields(topic).filter((f) => f.derived).length, 3);
  }
  for (const f of [fields("arbitrary_topic"), fields("vehicle_attitude", "uint8_t"),
    fields("vehicle_attitude", "float", 3), fields("vehicle_odometry", "float", 4, false)]) {
    assert.equal(f.filter((field) => field.derived).length, 0);
  }
  const subscription = {name: "vehicle_odometry", fields: [
    {name: "q", type: "float", arrayLength: 4, isComplex: false},
    {name: "pose_frame", type: "uint8_t", isComplex: false},
  ]};
  const data = {times: Float64Array.from([0, 1, 2, 3, 2, 5]), columns: new Map([
    ["q[0]", Float64Array.from([1, 1, 1, 0, 1, 1])],
    ...[1, 2, 3].map((i) => [`q[${i}]`, new Float64Array(6)]),
    ["pose_frame", Float64Array.from([1, 2, 0, 1, 1, 1])],
  ])};
  addDerivedRpyColumns(data, subscription, new Map());
  for (const angle of ["roll", "pitch", "yaw"]) {
    const values = data.columns.get(`derived_rpy_q.${angle}`);
    assert.equal(values.length, data.times.length);
    for (const i of [0, 1, 5]) near(values[i], 0);
    for (const i of [2, 3, 4]) assert.ok(Number.isNaN(values[i]));
  }
  assert.equal(data.columns.get("q[0]")[3], 0); // raw logged data preserved
  const missing = {times: new Float64Array(1), columns: new Map()};
  assert.throws(() => addDerivedRpyColumns(missing, subscription, new Map()), /missing/);
  console.log("Quaternion tests passed: rotations, normalization, invalid data, singularities, and schema gates.");
} finally {
  await rm(dir, {recursive: true, force: true});
}
