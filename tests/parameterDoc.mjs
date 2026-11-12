import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const dir = await mkdtemp(join(tmpdir(), "ulog-param-doc-"));
try {
  await build({ entryPoints: ["src/ulogData.ts"], outdir: dir,
    bundle: true, platform: "node", format: "esm", outExtension: { ".js": ".mjs" } });
  const { parameterDoc, parameterReferenceSources } = await import(pathToFileURL(join(dir, "ulogData.mjs")));
  const [primary, ...others] = Object.keys(parameterReferenceSources);
  assert.match(primary, /^v\d+\.\d+\.\d+$/); // the latest release leads
  assert.ok(others.includes("main"));
  assert.ok(Object.values(parameterReferenceSources).every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  assert.equal(parameterDoc("MPC_XY_VEL_MAX").source, primary);
  const speed = parameterDoc("MPC_XY_VEL_MAX");
  assert.equal(speed.units, "m/s");
  assert.ok(speed.shortDesc.length > 0 && Number.isFinite(speed.min) && Number.isFinite(speed.max) && Number.isFinite(speed.default));
  const yawMode = parameterDoc("MPC_YAW_MODE");
  assert.ok(yawMode.values.length > 1 && yawMode.values.every(([value, meaning]) => Number.isInteger(value) && typeof meaning === "string"));
  // Unknown names (fork parameters) and inherited object keys are not parameters.
  assert.equal(parameterDoc("NOT_A_PX4_PARAMETER"), undefined);
  assert.equal(parameterDoc("constructor"), undefined);
  console.log("Parameter reference tests passed: lookup, enum values, unknown names.");
} finally {
  await rm(dir, { recursive: true, force: true });
}
