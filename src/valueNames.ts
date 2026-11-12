/**
 * Names for the values of an integer field: an enum's constants, or the bits
 * of a bitmask. They come from PX4's .msg definitions (src/px4Messages.json,
 * see scripts/update-px4-msgs.mjs) because a ULog carries field names and
 * types but not constants.
 */
export interface ValueNames {
  /** "enum": the value is one of the constants. "bitmask": constants are
   *  masks (a 0 constant names the empty set). "bits": constants are bit
   *  positions. */
  kind: "enum" | "bitmask" | "bits";
  /** [constant value, name without the prefix its group shares]. */
  names: [number, string][];
}

/** The name(s) a value stands for, or undefined if it has none. */
export function describeValue(valueNames: ValueNames, value: number): string | undefined {
  if (!Number.isInteger(value) || value < 0) return undefined;
  if (valueNames.kind === "enum" || value === 0) {
    // A bit-position constant 0 names bit 0, not the value 0.
    return valueNames.kind === "bits" ? undefined : valueNames.names.find(([v]) => v === value)?.[1];
  }
  // Division rather than bitwise operators: masks can use bit 31 and above.
  const bitSet = (bit: number): boolean => Math.floor(value / 2 ** bit) % 2 === 1;
  const set = valueNames.names.filter(([v]) =>
    valueNames.kind === "bits" ? bitSet(v) : v > 0 && bitSet(Math.log2(v)));
  return set.length > 0 ? set.map(([, name]) => name).join(" | ") : undefined;
}
