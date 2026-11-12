// Regenerates src/px4Messages.json: for each PX4 message, the integer fields
// whose values have names (enums and bitmasks), taken from the .msg
// definitions in PX4's px4_msgs repository. Branches are merged newest first,
// so a message that has since been renamed or removed upstream (sensor_gps)
// keeps the last definition it had.
//
//   node scripts/update-px4-msgs.mjs
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMsg } from "./px4MsgParser.mjs";

const REPO = "https://github.com/PX4/px4_msgs";
const BRANCHES = ["main", "release/1.16", "release/1.15", "release/1.14"];

const messages = {};
const counts = {};
const commits = {};
const dir = await mkdtemp(join(tmpdir(), "px4-msgs-"));
try {
  for (const branch of BRANCHES) {
    const checkout = join(dir, branch.replace("/", "-"));
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", branch, REPO, checkout]);
    commits[branch] = execFileSync("git", ["-C", checkout, "rev-parse", "--short", "HEAD"]).toString().trim();
    counts[branch] = 0;
    for (const file of (await readdir(join(checkout, "msg"))).filter((f) => f.endsWith(".msg")).sort()) {
      const { formats, fields } = parseMsg(file, await readFile(join(checkout, "msg", file), "utf8"));
      for (const format of formats) {
        if (messages[format]) continue;
        messages[format] = fields;
        counts[branch]++;
      }
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
// Messages without any named field carry nothing; drop them from the table.
const named = Object.fromEntries(Object.keys(messages).sort()
  .filter((name) => Object.keys(messages[name]).length > 0).map((name) => [name, messages[name]]));
const out = { fetched: new Date().toISOString().slice(0, 10), source: REPO, commits, messages: named };
await writeFile(new URL("../src/px4Messages.json", import.meta.url), JSON.stringify(out) + "\n");
const fieldCount = Object.values(named).reduce((n, fields) => n + Object.keys(fields).length, 0);
console.log(`${Object.keys(named).length} formats with named values (${fieldCount} fields); formats seen per branch:`, counts);
