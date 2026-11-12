// Extracts, from PX4 .msg definitions, which integer fields have named values:
// the constants a field is annotated with ([@enum PREFIX]), or failing that the
// ones that can be tied to it without guessing (see linkFields).

const INTEGER_TYPES = new Set(["uint8", "uint16", "uint32", "uint64", "int8", "int16", "int32", "int64"]);

/** PX4's CamelCase message name to its snake_case topic/format name. */
export function snakeCase(name) {
  return name.replace(/(.)([A-Z][a-z]+)/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Longest prefix ending in "_" shared by all names (empty if none, or for a single name). */
function commonPrefix(names) {
  if (names.length < 2) return "";
  let prefix = names[0];
  for (const name of names) {
    while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix.slice(0, prefix.lastIndexOf("_") + 1);
}

/**
 * Parses one .msg file into the format names it is logged under and, per
 * field that has named values, `{ kind, names: [[value, NAME], ...] }`.
 * kind is "enum" (the value is one of the constants), "bitmask" (constants
 * are masks, a 0 constant naming the empty set) or "bits" (constants are bit
 * positions).
 */
export function parseMsg(fileName, text) {
  const lines = [];
  let topics;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const topicsMatch = /^#\s*TOPICS\s+(.+)$/.exec(line);
    if (topicsMatch) topics = topicsMatch[1].trim().split(/\s+/);
    if (line === "") { lines.push({ blank: true }); continue; }
    if (line.startsWith("#")) continue;
    const [code, ...commentParts] = line.split("#");
    const comment = commentParts.join("#").trim();
    const constant = /^(\w+)\s+([A-Z][A-Z0-9_]*)\s*=\s*(\S+)$/.exec(code.trim());
    if (constant) {
      const value = Number(constant[3]);
      if (INTEGER_TYPES.has(constant[1]) && Number.isInteger(value)) {
        lines.push({ constant: true, type: constant[1], name: constant[2], value });
      } else {
        lines.push({ other: true });
      }
      continue;
    }
    const field = /^([\w/]+)(\[\d*\])?\s+([a-z_]\w*)$/.exec(code.trim());
    lines.push(field ? { field: true, type: field[1], name: field[3], comment } : { other: true });
  }
  const constants = lines.filter((l) => l.constant && l.name !== "MESSAGE_VERSION" && !l.name.startsWith("ORB_"));
  const fields = {};
  lines.forEach((line, index) => {
    if (!line.field || !INTEGER_TYPES.has(line.type)) return;
    const group = linkField(line, index, lines, constants);
    if (!group || group.length === 0) return;
    const prefix = commonPrefix(group.map((c) => c.name));
    const names = [];
    for (const c of group) {
      if (!names.some(([value]) => value === c.value)) names.push([c.value, c.name.slice(prefix.length) || c.name]);
    }
    fields[line.name] = { kind: valueKind(line.comment, names), names };
  });
  const base = fileName.replace(/\.msg$/, "");
  return { formats: [...new Set([snakeCase(base), ...(topics ?? [])])], fields };
}

/**
 * The constants naming a field's values, most certain rule first:
 *  1. `[@enum PREFIX]` on the field: every PREFIX_* constant.
 *  2. Constants named after the field (`fix_type` and FIX_TYPE_*).
 *  3. A run of same-typed constants with a common prefix directly below the
 *     field, or below a run of fields it is the last of (`nav_state` and the
 *     NAVIGATION_STATE_* lines under it). A blank line ends the run.
 * Anything looser would be a guess, so such fields are left unnamed.
 */
function linkField(field, index, lines, constants) {
  const annotation = /\[@enum\s+([A-Z][A-Z0-9_]*)\]/.exec(field.comment);
  if (annotation) return constants.filter((c) => c.name.startsWith(`${annotation[1]}_`));
  const named = constants.filter((c) => c.name.startsWith(`${field.name.toUpperCase()}_`));
  if (named.length >= 2) return named;
  let next = index + 1;
  while (lines[next]?.field && lines[next].type === field.type) next++;
  const run = [];
  while (lines[next]?.constant && lines[next].type === field.type) run.push(lines[next++]);
  return run.length >= 2 && commonPrefix(run.map((c) => c.name)) !== "" ? run : undefined;
}

function valueKind(comment, names) {
  if (!/bit\s?mask|bit\s?field|\bflags\b/i.test(comment)) return "enum";
  // Masks are all powers of two (a 0 constant then names "nothing set");
  // positions run 0, 1, 2, 3, ... and so include values that are not.
  const set = names.map(([value]) => value).filter((v) => v !== 0);
  return set.every((v) => v > 0 && Number.isInteger(Math.log2(v))) ? "bitmask" : "bits";
}
