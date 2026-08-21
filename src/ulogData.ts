/**
 * Pure ULog data access: summary building and time-series extraction.
 * No dependency on the vscode API so it can be exercised outside the
 * extension host (tests, scripts). Both operations run entirely off the
 * fast low-level scan in paramScan.ts — see that module's docstring for why
 * `ulog.open()`/`readMessages()` are never used at all.
 */
import { MessageType, type FieldPrimitive, type Filelike, type MessageDefinition, type Subscription } from "@foxglove/ulog";
import { scanTopicColumns, scanTopicStrings, type UlogFileScanResult } from "./paramScan";
import type {
  FieldInfo,
  FormatDefinitionInfo,
  LogSummary,
  MessageTypeCount,
  StringFieldInfo,
  TopicInfo,
  TopicStrings,
} from "./protocol";

/** Columnar time-series data extracted from one topic (subscription). */
export interface TopicColumns {
  /** Timestamps in seconds, ascending. */
  times: Float64Array;
  /** One column per plottable field, same length as `times`. */
  columns: Map<string, Float64Array>;
}

/**
 * Expand a subscription's definition into flat, plottable field names.
 * Nested structs get exactly one level of flattening: a single nested
 * struct (e.g. position_setpoint_triplet's `current`, a `position_setpoint`)
 * becomes `current.lat`, `current.lon`, …, and a nested struct *array*
 * (e.g. esc_status's `esc_report[8] esc`) becomes `esc[0].esc_rpm`,
 * `esc[1].esc_rpm`, … per instance. A nested field that's itself complex is
 * left alone rather than generalizing to arbitrary depth, since one level is
 * the only depth any real PX4 topic needs.
 */
export function plottableFields(subscription: Subscription, definitions: Map<string, MessageDefinition>): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const field of subscription.fields) {
    // Skip padding, strings, and the x-axis timestamp itself.
    if (field.name.startsWith("_") || field.type === "char" || field.name === "timestamp") {
      continue;
    }
    if (field.isComplex) {
      const nestedDef = definitions.get(field.type);
      if (!nestedDef) {
        continue;
      }
      const instanceCount = field.arrayLength ?? 1;
      for (let instance = 0; instance < instanceCount; instance++) {
        const prefix = field.arrayLength != undefined ? `${field.name}[${instance}]` : field.name;
        for (const inner of nestedDef.fields) {
          // Unlike the top-level `timestamp` (the x-axis, skipped above), a
          // nested struct's own timestamp is real data — e.g. each
          // esc_report's last-telemetry-update time, whose flat segments
          // expose a per-ESC dropout — so it stays plottable.
          if (inner.name.startsWith("_") || inner.isComplex || inner.type === "char") {
            continue;
          }
          if (inner.arrayLength != undefined) {
            for (let i = 0; i < inner.arrayLength; i++) {
              fields.push({ name: `${prefix}.${inner.name}[${i}]`, type: inner.type });
            }
          } else {
            fields.push({ name: `${prefix}.${inner.name}`, type: inner.type });
          }
        }
      }
      continue;
    }
    if (field.arrayLength != undefined) {
      for (let i = 0; i < field.arrayLength; i++) {
        fields.push({ name: `${field.name}[${i}]`, type: field.type });
      }
    } else {
      fields.push({ name: field.name, type: field.type });
    }
  }
  return fields;
}

/**
 * The `char[N]` (string) fields of a subscription — the topic's text metadata
 * (device names, firmware/serial strings, …), which `plottableFields` above
 * deliberately skips because a string isn't a scalar and can't be plotted.
 * Only top-level `char[N]` fields are reported, matching `scanTopicStrings`'s
 * own extraction scope (paramScan.ts) — keep the two in sync by hand.
 */
export function stringFields(subscription: Subscription): StringFieldInfo[] {
  const fields: StringFieldInfo[] = [];
  for (const field of subscription.fields) {
    if (!field.name.startsWith("_") && field.type === "char" && field.arrayLength != undefined) {
      fields.push({ name: field.name, length: field.arrayLength });
    }
  }
  return fields;
}

/**
 * Extract (and cache) all plottable columns for a topic, via the fast
 * low-level scan in paramScan.ts.
 */
export function extractTopicColumns(filelike: Filelike, scan: UlogFileScanResult, msgId: number): Promise<TopicColumns> {
  return scanTopicColumns(filelike, scan, msgId);
}

/**
 * Reconstruct (via the fast scan in paramScan.ts) the decoded values of a
 * topic's `char[N]` string fields — the non-plottable counterpart to
 * `extractTopicColumns` above.
 */
export function extractTopicStrings(filelike: Filelike, scan: UlogFileScanResult, msgId: number): Promise<TopicStrings> {
  return scanTopicStrings(filelike, scan, msgId);
}

/**
 * Builds the summary from an already-scanned file (see `scanUlogFile` in
 * paramScan.ts) — deliberately not from `ulog.header`/`ulog.subscriptions`,
 * which would require the library's own (much slower) `ulog.open()`
 * indexing pass. `scan` here and `extractTopicColumns` above both run off
 * the same fast scan primitives, so there is no `ulog.open()` anywhere in
 * this extension.
 */
export function buildSummary(scan: UlogFileScanResult, fileName: string, fileSizeBytes: number): LogSummary {
  const [startSec, endSec] = scan.timeRange ?? [0, 0];

  const info: [string, string][] = [...scan.information.entries()].map(([key, value]) => [
    key,
    formatInfoValue(value),
  ]);

  const parameters = [...scan.parameters.entries()]
    .map(([name, value]) => ({
      name,
      value,
      defaultValue: scan.defaultsByParam.get(name),
      changes: meaningfulParameterChanges(value, scan.changesByParam.get(name) ?? []),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    fileName,
    fileSizeBytes,
    ulogVersion: scan.ulogVersion,
    timeRange: [startSec, endSec],
    durationSec: Math.max(0, endSec - startSec),
    info,
    parameters,
    topics: buildTopics(scan),
    logMessages: scan.logMessages,
    messageCount: scan.messageCount,
    utcOffsetUsec: scan.utcOffsetUsec,
    utcUnavailableReason: scan.utcUnavailableReason,
    headerSizeBytes: scan.dataSectionStart,
    messageTypeCounts: buildMessageTypeCounts(scan),
    formatDefinitions: buildFormatDefinitions(scan),
    dropouts: scan.dropouts,
    fileHeaderTimestampUsec: scan.fileHeaderTimestampUsec,
    hasDefaultParametersFlag: scan.hasDefaultParametersFlag,
    hasAppendedDataFlag: scan.hasAppendedDataFlag,
    appendedDataOffset: scan.appendedDataOffset,
    untrustedTopics: scan.untrustedTopics,
    logLevelCounts: buildLogLevelCounts(scan),
  };
}

/**
 * paramScan.ts records a "change" for every Parameter/ParameterDefault
 * message physically found in the data section — that's simply where the
 * message *is*, not evidence the value actually differs from what came
 * before it. PX4 loggers can (and do) re-write a parameter's current value
 * mid-flight without it having changed (e.g. a periodic full re-log of
 * every parameter), which would otherwise show up as a spurious "changed
 * mid-flight" entry whose value is identical to the initial one. Filters
 * those out by walking the raw list in chronological order and keeping
 * only entries that differ from whatever value was current immediately
 * before them — starting from `initialValue` (the header/initial value,
 * i.e. whatever was current the instant the data section began).
 */
function meaningfulParameterChanges(initialValue: number, rawChanges: number[]): number[] {
  const meaningful: number[] = [];
  let previousValue = initialValue;
  for (const value of rawChanges) {
    if (value !== previousValue) {
      meaningful.push(value);
    }
    previousValue = value;
  }
  return meaningful;
}

function messageTypeLabel(typeCode: number): string {
  const name = (MessageType as unknown as Record<number, string | undefined>)[typeCode];
  return name ?? `Unknown (0x${typeCode.toString(16)})`;
}

function buildMessageTypeCounts(scan: UlogFileScanResult): MessageTypeCount[] {
  return [...scan.messageTypeCounts.entries()]
    .map(([typeCode, count]) => ({ typeCode, count, label: messageTypeLabel(typeCode) }))
    .sort((a, b) => b.count - a.count);
}

function buildFormatDefinitions(scan: UlogFileScanResult): FormatDefinitionInfo[] {
  return [...scan.definitions.values()]
    .map((def) => ({ name: def.name, format: def.format }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const LOG_LEVEL_COUNT = 8; // 0 Emerg .. 7 Debug

/** Some sources log a level already ASCII-encoded (PX4's own '6' for INFO
 *  arrives as byte 54, not 6) — the webview's per-message rendering already
 *  corrects for this itself, but this aggregate needs the same correction
 *  applied *before* counting, or a log mixing both conventions would split
 *  one logical level across two raw byte values instead of merging them. */
function resolveLogLevel(rawLevel: number): number {
  if (rawLevel >= 0 && rawLevel < LOG_LEVEL_COUNT) {
    return rawLevel;
  }
  const asciiDecoded = rawLevel - 48;
  return asciiDecoded >= 0 && asciiDecoded < LOG_LEVEL_COUNT ? asciiDecoded : rawLevel;
}

function buildLogLevelCounts(scan: UlogFileScanResult): { level: number; count: number }[] {
  const resolved = new Map<number, number>();
  for (const [rawLevel, count] of scan.logLevelCounts) {
    const level = resolveLogLevel(rawLevel);
    resolved.set(level, (resolved.get(level) ?? 0) + count);
  }
  return [...resolved.entries()].map(([level, count]) => ({ level, count })).sort((a, b) => a.level - b.level);
}

function buildTopics(scan: UlogFileScanResult): TopicInfo[] {
  // A topic is "multi-instance" if any subscription of the same name has multiId > 0.
  const maxMultiId = new Map<string, number>();
  for (const subscription of scan.subscriptions.values()) {
    const current = maxMultiId.get(subscription.name) ?? 0;
    maxMultiId.set(subscription.name, Math.max(current, subscription.multiId));
  }

  const topics: TopicInfo[] = [];
  for (const [msgId, subscription] of scan.subscriptions) {
    const isMulti = (maxMultiId.get(subscription.name) ?? 0) > 0;
    topics.push({
      msgId,
      name: isMulti ? `${subscription.name} [${subscription.multiId}]` : subscription.name,
      messageName: subscription.name,
      multiId: subscription.multiId,
      count: scan.dataMessageCounts.get(msgId) ?? 0,
      fields: plottableFields(subscription, scan.definitions),
      stringFields: stringFields(subscription),
    });
  }
  return topics.sort((a, b) => a.name.localeCompare(b.name));
}

function formatInfoValue(value: FieldPrimitive | FieldPrimitive[]): string {
  if (Array.isArray(value)) {
    return value.map((entry) => formatInfoValue(entry)).join(", ");
  }
  return String(value);
}
