import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseMsg, snakeCase } from "../scripts/px4MsgParser.mjs";

const dir = await mkdtemp(join(tmpdir(), "ulog-value-names-"));
try {
  await build({ entryPoints: ["src/valueNames.ts", "src/ulogData.ts"], outdir: dir,
    bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" } });
  const { describeValue } = await import(pathToFileURL(join(dir, "valueNames.mjs")));
  const { fieldValueNames, plottableFields } = await import(pathToFileURL(join(dir, "ulogData.mjs")));

  assert.equal(snakeCase("VehicleStatus"), "vehicle_status");
  assert.equal(snakeCase("SensorGnss"), "sensor_gnss");
  assert.equal(snakeCase("EscReport"), "esc_report");

  const { formats, fields } = parseMsg("DemoStatus.msg", `
# TOPICS demo_status demo_status_sim
uint32 MESSAGE_VERSION = 1
uint64 timestamp # time since system start

uint8 state # [@enum MODE] annotated, constants elsewhere
uint8 fix_type # named after the field
uint8 FIX_TYPE_NONE = 1
uint8 FIX_TYPE_3D = 3

uint8 first_reason
uint8 last_reason
uint8 REASON_STICK = 1 # comment
uint8 REASON_SWITCH = 0x02

uint8 unrelated # blank line above the constants: not linked

uint8 MODE_A = 0
uint8 MODE_B = 1
uint8 MODE_B_ALIAS = 1

uint16 failures # [@enum FAILURE] Bitmask of faults
uint8 FAILURE_OVER_CURRENT = 0 # (1 << 0)
uint8 FAILURE_STUCK = 3
uint32 flags # [@enum FLAG] status flags
uint32 FLAG_NONE = 0
uint32 FLAG_A = 1
uint32 FLAG_B = 2
float32 scale # not an integer
float32 SCALE_MAX = 2.5
uint8 lonely
uint8 LONELY_ONLY = 1
`);
  assert.deepEqual(formats, ["demo_status", "demo_status_sim"]);
  assert.deepEqual(fields.state, { kind: "enum", names: [[0, "A"], [1, "B"]] });
  assert.deepEqual(fields.fix_type, { kind: "enum", names: [[1, "NONE"], [3, "3D"]] });
  assert.deepEqual(fields.first_reason, { kind: "enum", names: [[1, "STICK"], [2, "SWITCH"]] });
  assert.deepEqual(fields.last_reason, fields.first_reason);
  assert.deepEqual(fields.failures, { kind: "bits", names: [[0, "OVER_CURRENT"], [3, "STUCK"]] });
  assert.deepEqual(fields.flags, { kind: "bitmask", names: [[0, "NONE"], [1, "A"], [2, "B"]] });
  assert.deepEqual(Object.keys(fields).sort(), ["failures", "first_reason", "fix_type", "flags", "last_reason", "state"]);

  assert.equal(describeValue(fields.state, 1), "B");
  assert.equal(describeValue(fields.state, 7), undefined);
  assert.equal(describeValue(fields.state, NaN), undefined);
  assert.equal(describeValue(fields.failures, 0), undefined);
  assert.equal(describeValue(fields.failures, 1), "OVER_CURRENT");
  assert.equal(describeValue(fields.failures, 9), "OVER_CURRENT | STUCK");
  assert.equal(describeValue(fields.failures, 4), undefined); // only an unnamed bit set
  assert.equal(describeValue(fields.flags, 0), "NONE");
  assert.equal(describeValue(fields.flags, 3), "A | B");
  assert.equal(describeValue({ kind: "bitmask", names: [[2 ** 31, "TOP"], [2 ** 40, "HIGH"]] }, 2 ** 31 + 2 ** 40), "TOP | HIGH");

  // The bundled table, and how it reaches plottable fields.
  assert.equal(describeValue(fieldValueNames("vehicle_status", "nav_state", "uint8_t"), 5), "AUTO_RTL");
  assert.equal(describeValue(fieldValueNames("sensor_gps", "fix_type", "uint8_t"), 6), "RTK_FIXED");
  assert.equal(fieldValueNames("vehicle_status", "nav_state", "float"), undefined);
  assert.equal(fieldValueNames("vehicle_status", "constructor", "uint8_t"), undefined);
  assert.equal(fieldValueNames("no_such_topic", "nav_state", "uint8_t"), undefined);
  const scalar = (name, type) => ({ name, type, isComplex: false });
  const escStatus = plottableFields(
    { name: "esc_status", fields: [{ name: "esc", type: "esc_report", arrayLength: 2, isComplex: true }] },
    new Map([["esc_report", { name: "esc_report", fields: [scalar("failures", "uint16_t"), scalar("esc_rpm", "int32_t")] }]]));
  assert.equal(escStatus.find((f) => f.name === "esc[1].failures").valueNames.kind, "bits");
  assert.equal(escStatus.find((f) => f.name === "esc[1].esc_rpm").valueNames, undefined);
  console.log("Value name tests passed: msg parsing and linking rules, enum and bitmask naming, bundled table lookup.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
