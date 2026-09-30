import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "ulog-battery-"));
try {
  const outfile = join(dir, "battery.mjs");
  await build({ entryPoints: ["src/replayBattery.ts"], outfile, bundle: true, platform: "node", format: "esm" });
  const { batteryReadingsAt, batteryValueAt } = await import(pathToFileURL(outfile));
  const series = (times, values) => ({times: Float64Array.from(times), values: Float64Array.from(values)});
  const first = {name: "Battery [0]", remaining: series([1, 5], [0.8, 0.4]),
    voltage: series([1, 5], [24, 22]), current: series([2, 6], [10, 20]), connected: undefined};
  const second = {name: "Battery [1]", remaining: series([3, 7], [0.9, 0.7]),
    voltage: series([3, 7], [25, 23]), current: undefined, connected: series([3, 8], [1, 0])};
  const blank = {remaining: "—", voltage: "—", current: "—"};
  assert.deepEqual(batteryReadingsAt(first, 0), blank);
  assert.deepEqual(batteryReadingsAt(first, 1), {remaining: "80 %", voltage: "24.0 V", current: "—"});
  assert.deepEqual(batteryReadingsAt(first, 4), {remaining: "80 %", voltage: "24.0 V", current: "10.0 A"});
  assert.deepEqual(batteryReadingsAt(second, 4), {remaining: "90 %", voltage: "25.0 V", current: "—"});
  assert.deepEqual(batteryReadingsAt(first, 6), {remaining: "40 %", voltage: "22.0 V", current: "20.0 A"});
  assert.deepEqual(batteryReadingsAt(second, 8), blank);
  assert.deepEqual(batteryReadingsAt({...first, remaining: series([0], [-1]),
    voltage: series([0], [NaN]), current: series([0], [-1])}, 4), blank);
  assert.ok(Number.isNaN(batteryValueAt(series([], []), 4)));
  console.log("Replay battery tests passed: independent timelines, seeking, missing data, invalid readings, and disconnection.");
} finally {
  await rm(dir, {recursive: true, force: true});
}
