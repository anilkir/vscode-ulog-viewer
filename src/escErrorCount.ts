/**
 * Interpretation of esc_report's `esc_errorcount`, for logs whose esc_report
 * also carries `esc_errorcount_type` (the ERRORCOUNT_TYPE_* enum saying what
 * the count means — ESC vendors differ, and some pack the CAN transmit and
 * receive error counters into the one field). The enum's constants are not
 * part of a ULog's format definitions, so they are mirrored here. Logs without
 * the type field get none of this and show the count as a plain number.
 */
import type { MessageDefinition } from "@foxglove/ulog";
import type { ValueNames } from "./valueNames";

export const ERRORCOUNT_TYPE_CAN_TEC = 5;
export const ERRORCOUNT_TYPE_CAN_REC = 6;
export const ERRORCOUNT_TYPE_CAN_TEC_REC_PACKED = 8;

// The esc_report ERRORCOUNT_TYPE_* constant names, as in PX4's msg/EscReport.msg.
const typeNames = [
  "UNKNOWN", "ESC_FAULTS", "TELEMETRY_ERRORS", "SERIAL_TELEMETRY_ERRORS", "BDSHOT_TELEMETRY_ERRORS",
  "CAN_TEC", "CAN_REC", "CAN_TEC_REC_MAX", "CAN_TEC_REC_PACKED", "CAN_ERRORS",
];

/** The PX4 constant name without its ERRORCOUNT_TYPE_ prefix, e.g. "CAN_TEC_REC_PACKED". */
/** esc_errorcount_type's values, for fields the bundled PX4 message table doesn't name yet. */
export const errorCountTypeNames: ValueNames = { kind: "enum", names: typeNames.map((name, value) => [value, name]) };

/** Whether a nested struct definition is an esc_report that says what its error count means. */
export function hasErrorCountType(definition: MessageDefinition): boolean {
  const scalar = (name: string, type: string): boolean =>
    definition.fields.some((f) => f.name === name && f.type === type && f.arrayLength == undefined && !f.isComplex);
  return definition.name === "esc_report" && scalar("esc_errorcount", "uint32_t") && scalar("esc_errorcount_type", "uint8_t");
}

export const errorCountField = (prefix: string): string => `${prefix}.esc_errorcount`;
export const errorCountTypeField = (prefix: string): string => `${prefix}.esc_errorcount_type`;
export const canTecField = (prefix: string): string => `${prefix}.derived_can_tec`;
export const canRecField = (prefix: string): string => `${prefix}.derived_can_rec`;

export const canCounterDescription =
  "Decoded from logged esc_errorcount using esc_errorcount_type, not directly logged. " +
  "Has a value only while the type is this counter alone or CAN_TEC_REC_PACKED.";

/**
 * Splits the logged count into separate CAN TEC and REC series. A sample has
 * a value only where the type identifies that counter (alone, or packed with
 * the other one); every other type leaves it NaN rather than guessing.
 */
export function decodeCanCounters(counts: Float64Array, types: Float64Array): { tec: Float64Array; rec: Float64Array } {
  const tec = new Float64Array(counts.length).fill(NaN);
  const rec = new Float64Array(counts.length).fill(NaN);
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i]!;
    if (!Number.isInteger(count) || count < 0 || count > 0xffffffff) continue;
    switch (types[i]) {
      case ERRORCOUNT_TYPE_CAN_TEC: tec[i] = count; break;
      case ERRORCOUNT_TYPE_CAN_REC: rec[i] = count; break;
      case ERRORCOUNT_TYPE_CAN_TEC_REC_PACKED:
        tec[i] = count >>> 16;
        rec[i] = count & 0xffff;
        break;
    }
  }
  return { tec, rec };
}
