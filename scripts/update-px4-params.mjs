// Regenerates src/px4Parameters.json: the PX4 parameter reference (descriptions,
// default/min/max, units, enum values, bitmask bits) bundled with the extension.
//
// Source is the parameters.json PX4's CI publishes with each build, the same
// metadata docs.px4.io's parameter reference is generated from. The latest
// release is the reference; other versions only fill in parameters it doesn't
// have, newest first: the main branch and the newest pre-release for ones not
// released yet, then older releases for ones since removed or renamed. Every
// entry records the version it came from.
//
//   node scripts/update-px4-params.mjs
import { writeFile } from "node:fs/promises";

const BUCKET = "https://px4-travis.s3.amazonaws.com";
const url = (version) => `${BUCKET}/Firmware/${version}/_general/parameters.json`;
/** Label for the unreleased main branch (published under "master"). */
const MAIN = "main";

/** Every published version directory, e.g. "v1.17.0", "v1.18.0-rc1". */
async function publishedVersions() {
  const versions = [];
  let token;
  do {
    const query = `list-type=2&prefix=Firmware/&delimiter=/${token ? `&continuation-token=${encodeURIComponent(token)}` : ""}`;
    const xml = await (await fetch(`${BUCKET}/?${query}`)).text();
    for (const [, name] of xml.matchAll(/<Prefix>Firmware\/(v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\d+)?)\/<\/Prefix>/g)) versions.push(name);
    token = /<NextContinuationToken>([^<]+)</.exec(xml)?.[1];
  } while (token);
  return versions;
}

/** Sortable key: release after its own pre-releases, numeric throughout. */
function versionKey(version) {
  const [, major, minor, patch, stage, n] = /^v(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(\d+))?$/.exec(version);
  return [major, minor, patch, { alpha: 0, beta: 1, rc: 2 }[stage] ?? 3, n ?? 0].map(Number);
}
const compareVersions = (a, b) => {
  const [ka, kb] = [versionKey(a), versionKey(b)];
  return ka.map((part, i) => part - kb[i]).find((d) => d !== 0) ?? 0;
};

const all = (await publishedVersions()).sort(compareVersions).reverse();
// Newest patch of each minor release, newest first.
const releases = [];
for (const version of all.filter((v) => !v.includes("-"))) {
  const minor = version.split(".").slice(0, 2).join(".");
  if (!releases.some((r) => r.startsWith(`${minor}.`))) releases.push(version);
}
const newestPreRelease = all[0]?.includes("-") ? [all[0]] : [];
const candidates = [...releases.slice(0, 1), MAIN, ...newestPreRelease, ...releases.slice(1)];

const parameters = {};
const sources = {};
const counts = {};
for (const version of candidates) {
  const response = await fetch(url(version === MAIN ? "master" : version));
  if (response.status === 404 || response.status === 403) continue; // older releases published no parameter metadata
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  const { parameters: list } = await response.json();
  const lastModified = new Date(response.headers.get("last-modified") ?? NaN);
  sources[version] = Number.isNaN(lastModified.getTime()) ? "unknown date" : lastModified.toISOString().slice(0, 10);
  counts[version] = 0;
  for (const p of list) {
    if (parameters[p.name]) continue;
    counts[version]++;
    const longDesc = p.longDesc?.trim();
    parameters[p.name] = {
      shortDesc: p.shortDesc?.trim() ?? "",
      ...(longDesc && longDesc !== p.shortDesc?.trim() ? { longDesc } : {}),
      default: p.default, min: p.min, max: p.max, units: p.units,
      ...(p.values?.length ? { values: p.values.map((v) => [v.value, v.description]) } : {}),
      ...(p.bitmask?.length ? { bitmask: p.bitmask.map((b) => [b.index, b.description]) } : {}),
      ...(p.rebootRequired ? { rebootRequired: true } : {}),
      source: version,
    };
  }
}
if (Object.keys(sources).length === 0) throw new Error("No published parameter metadata found");
const sorted = Object.fromEntries(Object.keys(parameters).sort().map((name) => [name, parameters[name]]));
const out = { fetched: new Date().toISOString().slice(0, 10), sources, parameters: sorted };
await writeFile(new URL("../src/px4Parameters.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log(`${Object.keys(sorted).length} parameters; new names per source, in priority order:`, counts, "published:", sources);
