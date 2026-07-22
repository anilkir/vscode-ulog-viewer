/**
 * Single-pass, low-level scan of the *entire* ULog file — header section
 * and data section — that replaces the need to call the public `ulog.open()`
 * at all for building the summary view.
 *
 * Why not just use `ulog.open()` plus the public `readMessages()` API:
 *
 *  - `ulog.open()`'s internal indexing pass (`#createIndex`) reads through
 *    the library's own `ChunkedReader`, whose read methods are all `async`.
 *    Even when the underlying bytes are already buffered in memory (no real
 *    disk I/O needed), each `await` still costs real V8 microtask overhead.
 *    For a few hundred thousand messages that's a lot of awaited calls, and
 *    measured on one real machine, `ulog.open()` alone took *120 seconds*
 *    for a 24MB file — of which only 1.2 seconds was actual read() time.
 *    The other ~119 seconds was exactly this per-message await overhead,
 *    apparently far worse on that machine than in our own testing.
 *  - Separately, `ulog.header.parameters` doesn't preserve whether a value
 *    came from a 'P' (current) or 'Q' (default) message, and there's no way
 *    to distinguish "header section" parameter declarations (initial
 *    values) from "data section" ones (genuine mid-flight changes) through
 *    the public API at all.
 *
 * So we read message headers ourselves via the library's lower-level
 * exported primitives (MessageType, parseFieldDefinition,
 * parseBasicFieldValue, parseMessageDefinition, fieldSize) and only decode
 * the few bytes we actually need from each message. This also means a
 * handful of non-PX4-native topics with malformed or unusual layouts
 * (observed in the wild: extra companion-computer metrics topics) can't
 * crash or slow down the scan — we just exclude what we can't trust rather
 * than fully parsing it.
 *
 * `scanTopicColumns()` below reuses this same scan's parsed subscriptions/
 * definitions plus a cached data-section start offset to serve on-demand
 * per-topic series extraction too, so `ulog.open()`/`readMessages()` are
 * never called at all — the ~120s cost above is avoided entirely rather
 * than just hidden behind a background task.
 */
import {
  MessageType,
  parseFieldDefinition,
  parseBasicFieldValue,
  parseMessageDefinition,
  fieldSize,
  type Filelike,
  type FieldPrimitive,
  type MessageDefinition,
  type Subscription,
} from "@foxglove/ulog";
import type { LogMessageInfo, StringRecord, TopicStrings } from "./protocol";

const US_PER_SEC = 1e6;
const PROLOGUE_BYTES = 16; // 7-byte magic + 1-byte version + 8-byte file timestamp
const MAGIC = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];
const MAX_SANE_TIMESTAMP_US = BigInt(7 * 24 * 3600 * 1_000_000); // 1 week
// A GPS fix's reported UTC time is trusted only within this range — wide
// enough to never reject a genuine fix (PX4 predates 2013; nothing sane
// logs a fix a century out), narrow enough to catch a corrupt/garbage
// time_utc_usec value rather than silently computing a nonsense offset
// from it.
const MIN_SANE_UTC_MS = BigInt(Date.UTC(2000, 0, 1));
const MAX_SANE_UTC_MS = BigInt(Date.UTC(2100, 0, 1));
/**
 * Fewer, larger reads rather than many small ones, since each `read()` call
 * can carry real per-call overhead independent of how many bytes it
 * transfers (network drives, some remote-dev setups, antivirus-scanned
 * mounts, etc.).
 */
const CHUNK_SIZE = 8 * 1024 * 1024;

/** Message types that only ever occur in the header section — everything
 *  else (including 'Unknown') marks the start of the data section. */
const DATA_SECTION_TYPES = new Set<number>([
  MessageType.AddLogged,
  MessageType.RemoveLogged,
  MessageType.Data,
  MessageType.Log,
  MessageType.LogTagged,
  MessageType.Synchronization,
  MessageType.Dropout,
]);

export interface ParsedParameter {
  value: number;
  defaultTypes: number;
}

export interface UlogFileScanResult {
  ulogVersion: number;
  information: Map<string, FieldPrimitive | FieldPrimitive[]>;
  /** Current (header-section) parameter values — matches `ulog.header.parameters` semantics. */
  parameters: Map<string, ParsedParameter>;
  definitions: Map<string, MessageDefinition>;
  subscriptions: Map<number, Subscription>;
  dataMessageCounts: Map<number, number>;
  messageCount: number;
  /** [start, end] of the data section in seconds, or undefined if no Data messages were found. */
  timeRange: [number, number] | undefined;
  /**
   * Absolute byte offset where the data section begins (the file size if no
   * data-section message was ever found). Lets `scanTopicColumns` jump
   * straight past the header/definitions section on a later, targeted pass
   * instead of re-parsing it.
   */
  dataSectionStart: number;
  /** Absolute end of the data section — may be less than the file size if an appended section follows (see the FlagBits case below). */
  dataSectionEnd: number;
  /**
   * Mid-flight parameter changes, keyed by parameter name — each entry is
   * just the value it changed to, in chronological order. No timestamp:
   * Parameter messages don't carry their own, and the closest available
   * proxy (the most recently-seen Data message's own timestamp at the
   * point this message was encountered in the file) is only an
   * approximation of when it actually happened, not trustworthy enough to
   * surface as if it were exact.
   */
  changesByParam: Map<string, number[]>;
  /**
   * PX4's recorded default value for each parameter, from 'Q'
   * (ParameterDefault) messages — distinct from the *current* value. Lets
   * us show "this was changed from its build-time default" using data
   * already in the log, with no external version-specific database needed.
   */
  defaultsByParam: Map<string, number>;
  logMessages: LogMessageInfo[];
  /**
   * `time_utc_usec - timestamp` from the first GPS message with a valid fix
   * (see GPS_UTC_TOPICS), in microseconds — added to any other message's own
   * boot-relative `timestamp` to get its real-world UTC time. A single
   * reference sample, not a per-message correction: boot-relative and UTC
   * clocks advance at effectively the same rate over one flight, so one
   * offset is all "wall clock" display needs. Undefined if the log has no
   * GPS topic, or never got a fix with a valid time.
   */
  utcOffsetUsec: number | undefined;
  /** Human-readable explanation for why `utcOffsetUsec` is undefined — unset
   *  when it isn't (nothing to explain). Surfaced as the disabled "Clock"
   *  time-axis option's tooltip. */
  utcUnavailableReason: string | undefined;
  /** Every message type seen (header or data section), by its numeric type
   *  byte — for a raw structural view of the file, not shown anywhere else. */
  messageTypeCounts: Map<number, number>;
  /** Logged gaps in the data section — each is a `duration`-only message
   *  (see MessageType.Dropout), so its time is inferred from the last real
   *  Data message's timestamp seen just before it, same as a mid-flight
   *  parameter change's timeSec above. */
  dropouts: { timeSec: number; durationMs: number }[];
  /** The file header's own self-reported start time, in microseconds — raw
   *  and unvalidated (see where it's read for why). */
  fileHeaderTimestampUsec: number;
  /** Bit 0 of the FlagBits message's compatibleFlags — whether this log's
   *  parameters carry recorded build-time defaults (see defaultsByParam). */
  hasDefaultParametersFlag: boolean;
  /** Bit 0 of FlagBits' incompatibleFlags — whether this file has a section
   *  appended after the data section (see appendedDataOffset). */
  hasAppendedDataFlag: boolean;
  /** Absolute byte offset of the appended section, if hasAppendedDataFlag
   *  and a valid offset were both present. */
  appendedDataOffset: number | undefined;
  /** Log/LogTagged message counts by syslog level (0 Emerg .. 7 Debug). */
  logLevelCounts: Map<number, number>;
  /** Subscriptions this scan couldn't resolve a trustworthy timestamp field
   *  for (see `untrustedMsgIds` above) — excluded from this scan's own
   *  time-range/parameter-change computations without saying so anywhere
   *  else. Typically non-PX4-native companion-computer topics with unusual
   *  layouts. */
  untrustedTopics: { msgId: number; name: string }[];
}

/**
 * Minimal buffered reader over a `Filelike`, purpose-built for this
 * sequential forward-scanning use. Field reads (`u8`/`u16`/`u64`/`bytes`/
 * `str`) are plain synchronous functions — the caller is responsible for
 * calling `ensure(n)` first to guarantee the next `n` bytes are buffered.
 * `ensure` itself only awaits when a real refill is needed; checking that
 * first and skipping the `await` entirely otherwise is what avoids paying
 * Promise-microtask overhead on almost every message.
 */
class FastReader {
  private buf: Uint8Array = new Uint8Array(0);
  private view: DataView = new DataView(this.buf.buffer);
  private bufStart = 0;
  private pos: number;
  private readonly textDecoder = new TextDecoder();

  constructor(
    private readonly file: Filelike,
    private readonly fileSize: number,
    startPos: number,
  ) {
    this.pos = startPos;
  }

  position(): number {
    return this.pos;
  }

  seekTo(offset: number): void {
    this.pos = offset;
  }

  /** The DataView backing the currently-buffered chunk. Combined with
   *  `bufferStart()`, lets a caller decode fields at arbitrary offsets
   *  within an already-`ensure()`'d region without allocating a new view
   *  per field (see `scanTopicColumns` below). */
  rawView(): DataView {
    return this.view;
  }

  /** Absolute file offset of byte 0 of `rawView()`. */
  bufferStart(): number {
    return this.bufStart;
  }

  hasAvailable(len: number): boolean {
    return this.pos >= this.bufStart && this.pos + len <= this.bufStart + this.buf.byteLength;
  }

  async ensure(len: number): Promise<void> {
    if (this.hasAvailable(len)) {
      return;
    }
    const remaining = this.fileSize - this.pos;
    const toRead = Math.min(Math.max(CHUNK_SIZE, len), remaining);
    const data = await this.file.read(this.pos, toRead);
    this.buf = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.bufStart = this.pos;
  }

  u8(): number {
    const v = this.view.getUint8(this.pos - this.bufStart);
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos - this.bufStart, true);
    this.pos += 2;
    return v;
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.pos - this.bufStart, true);
    this.pos += 8;
    return v;
  }

  bytes(len: number): Uint8Array {
    const start = this.pos - this.bufStart;
    const out = this.buf.slice(start, start + len);
    this.pos += len;
    return out;
  }

  str(len: number): string {
    const start = this.pos - this.bufStart;
    const out = this.textDecoder.decode(this.buf.subarray(start, start + len));
    this.pos += len;
    return out;
  }
}

/**
 * Correct replacement for @foxglove/ulog's `computeTimetampOffset`, which has
 * two bugs relevant here:
 *
 *  1. It skips "_"-prefixed (padding) fields' byte size entirely when
 *     accumulating the running offset, instead of only skipping them from
 *     the parsed *value* output (which is what parseMessage() itself
 *     correctly does). Latent for standard PX4 topics because "timestamp"
 *     is always their first field, so the loop returns before ever reaching
 *     a padding field — it only surfaces for non-PX4-native messages that
 *     place "timestamp" later in the struct.
 *  2. It's only exported from the `ULog` class, which requires a fully
 *     `open()`'d instance — we need the equivalent logic without that
 *     dependency, so it's reimplemented here using only `fieldSize`.
 *
 * Generalized to any named field (not just "timestamp") so the same logic
 * can locate GPS messages' `time_utc_usec` below.
 */
function computeFieldOffset(
  definition: Subscription,
  definitions: Map<string, MessageDefinition>,
  fieldName: string,
  expectedType: string,
): number | undefined {
  let curOffset = 0;
  for (const field of definition.fields) {
    if (field.name === fieldName) {
      return field.type === expectedType ? curOffset : undefined;
    }
    curOffset += fieldSize(field, definitions) * (field.arrayLength ?? 1);
  }
  return undefined;
}

function computeTimestampOffset(
  definition: Subscription,
  definitions: Map<string, MessageDefinition>,
): number | undefined {
  return computeFieldOffset(definition, definitions, "timestamp", "uint64_t");
}

/** Topic names carrying a `time_utc_usec` field we can use to convert this
 *  log's boot-relative timestamps to real wall-clock time — "sensor_gps" is
 * preferred (current PX4), "vehicle_gps_position" is the older name it
 * replaced. */
const GPS_UTC_TOPICS = ["sensor_gps", "vehicle_gps_position"];

function isValidInfoField(field: ReturnType<typeof parseFieldDefinition>): boolean {
  return field?.isComplex === false;
}

function isValidParameterField(field: ReturnType<typeof parseFieldDefinition>): boolean {
  return Boolean(field && (field.type === "int32_t" || field.type === "float") && field.arrayLength == undefined);
}

export async function scanUlogFile(filelike: Filelike): Promise<UlogFileScanResult> {
  // Some Filelike implementations (e.g. the Node FileReader) don't know
  // their own size until open() has resolved, and this scan may run
  // concurrently with — or before — `ulog.open()`'s own call to the same
  // method. Safe to call regardless of ordering as long as the Filelike
  // treats a repeat open() as a no-op, which is the documented contract.
  await filelike.open();
  const fileSize = filelike.size();
  const reader = new FastReader(filelike, fileSize, 0);

  await reader.ensure(PROLOGUE_BYTES);
  const magic = reader.bytes(7);
  for (let i = 0; i < MAGIC.length; i++) {
    if (magic[i] !== MAGIC[i]) {
      throw new Error("Invalid ULog file (bad magic header)");
    }
  }
  const ulogVersion = reader.u8();
  // The file's own self-reported start timestamp — in practice often left 0
  // by real loggers (not universally populated), so shown as raw data on
  // the Structure tab rather than relied on for anything.
  const fileHeaderTimestampUsec = Number(reader.u64());

  const information = new Map<string, FieldPrimitive | FieldPrimitive[]>();
  const parameters = new Map<string, ParsedParameter>();
  const definitions = new Map<string, MessageDefinition>();
  const subscriptions = new Map<number, Subscription>();
  const dataMessageCounts = new Map<number, number>();
  const changesByParam = new Map<string, number[]>();
  const defaultsByParam = new Map<string, number>();
  const logMessages: LogMessageInfo[] = [];
  const timestampOffsetCache = new Map<number, number>();
  const untrustedMsgIds = new Set<number>();
  const messageTypeCounts = new Map<number, number>();
  const dropouts: { timeSec: number; durationMs: number }[] = [];
  // Keyed by topic name (not msgId — a topic can have several multi-instance
  // msgIds) so a preferred "sensor_gps" reference always wins over a
  // "vehicle_gps_position" one even if the latter's Data messages happen to
  // come first in the file.
  const gpsUtcOffsetByTopic = new Map<string, bigint>();
  const gpsUtcFieldOffsetCache = new Map<number, number | undefined>();
  // Distinguishes *why* utcOffsetUsec ends up undefined, for the "Clock"
  // time-axis option's disabled-state tooltip.
  let gpsTopicSeen = false;
  let gpsNonzeroUtcSeen = false;

  let dataEnd = fileSize;
  let inDataSection = false;
  let dataSectionStart: number | undefined;
  let currentUs = 0n;
  let dataMinUs: bigint | undefined;
  let dataMaxUs: bigint | undefined;
  let messageCount = 0;
  const logLevelCounts = new Map<number, number>();
  // From the one (at most) FlagBits message — see its case below. Defaults
  // match "no FlagBits message at all", which older ulog files never had.
  let hasDefaultParametersFlag = false;
  let hasAppendedDataFlag = false;
  let appendedDataOffset: number | undefined;

  while (dataEnd - reader.position() >= 3) {
    if (!reader.hasAvailable(3)) {
      await reader.ensure(3);
    }
    const size = reader.u16();
    const type = reader.u8();
    const bodyStart = reader.position();
    const bodyEnd = bodyStart + size;
    if (bodyEnd > dataEnd) {
      break;
    }
    if (!reader.hasAvailable(size)) {
      await reader.ensure(size);
    }

    if (!inDataSection && DATA_SECTION_TYPES.has(type)) {
      inDataSection = true;
      dataSectionStart = bodyStart - 3; // back up over this message's own [size, type] header
    }
    // Matches `ulog.messageCount()` semantics exactly: it's `#timeIndex.length`,
    // which only ever accumulates entries once the library's own indexing
    // pass reaches the data section — header-section messages (Information,
    // Parameter, FormatDefinition, ...) are processed but never indexed.
    if (inDataSection) {
      messageCount++;
    }
    messageTypeCounts.set(type, (messageTypeCounts.get(type) ?? 0) + 1);

    try {
      switch (type) {
        case MessageType.FlagBits: {
          // Only bit 0 of each is spec'd so far (see CompatibleFlags /
          // IncompatibleFlags in @foxglove/ulog's enums) — the rest of each
          // 64-bit field is reserved/unused, so a plain bit-0 check is all
          // there is to decode.
          const compatFlags = reader.u64();
          const incompatFlags = reader.u64();
          hasDefaultParametersFlag = (compatFlags & 1n) !== 0n;
          hasAppendedDataFlag = (incompatFlags & 1n) !== 0n;
          const firstAppended = Number(reader.u64());
          reader.u64();
          reader.u64(); // remaining appendedOffsets, unused
          if (firstAppended > 0 && firstAppended < fileSize) {
            dataEnd = firstAppended;
            appendedDataOffset = firstAppended;
          }
          break;
        }
        case MessageType.Information: {
          const keyLen = reader.u8();
          const key = reader.str(keyLen);
          const valueBytes = reader.bytes(size - 1 - keyLen);
          // Upstream's own header-parsing loop unconditionally stops the
          // instant the data section starts and never resumes — so an 'I'
          // message occurring afterward (some logs append a postflight
          // diagnostics dump after all telemetry, using ordinary
          // Information/InformationMulti messages) is never added to its
          // `header.information` map. Matching that exactly here, rather
          // than "usefully" capturing it, avoids silently disagreeing with
          // every other consumer of this same file.
          if (!inDataSection) {
            const field = parseFieldDefinition(key);
            if (isValidInfoField(field)) {
              const view = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
              information.set(field!.name, parseBasicFieldValue(field!, view));
            }
          }
          break;
        }
        case MessageType.InformationMulti: {
          reader.u8(); // isContinued, unused
          const keyLen = reader.u8();
          const key = reader.str(keyLen);
          const valueBytes = reader.bytes(size - 2 - keyLen);
          if (!inDataSection) {
            const field = parseFieldDefinition(key);
            if (isValidInfoField(field)) {
              const view = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
              const parsed = parseBasicFieldValue(field!, view);
              // Matches upstream ULog.js's own choice of the raw key string
              // (not field.name) as the map key for repeated Info-Multi entries.
              let arr = information.get(key);
              if (!Array.isArray(arr)) {
                arr = [];
                information.set(key, arr);
              }
              arr.push(parsed);
            }
          }
          break;
        }
        case MessageType.FormatDefinition: {
          const format = reader.str(size);
          // Same reasoning as Information above: format (re-)declarations
          // after the data section starts aren't recognized by upstream.
          if (!inDataSection) {
            const def = parseMessageDefinition(format);
            if (def) {
              definitions.set(def.name, def);
            }
          }
          break;
        }
        case MessageType.Parameter:
        case MessageType.ParameterDefault: {
          const isDefault = type === MessageType.ParameterDefault;
          const defaultTypes = isDefault ? reader.u8() : 0;
          const keyLen = reader.u8();
          const key = reader.str(keyLen);
          const valueBytes = reader.bytes(size - (isDefault ? 2 : 1) - keyLen);
          const field = parseFieldDefinition(key);
          if (isValidParameterField(field)) {
            const view = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
            const value = parseBasicFieldValue(field!, view) as number;
            if (isDefault) {
              defaultsByParam.set(field!.name, value);
            }
            if (inDataSection) {
              const list = changesByParam.get(field!.name);
              if (list) {
                list.push(value);
              } else {
                changesByParam.set(field!.name, [value]);
              }
            } else {
              // Header section: this is the current/initial value — last
              // P-or-Q write wins, matching ulog.header.parameters semantics.
              parameters.set(field!.name, { value, defaultTypes });
            }
          }
          break;
        }
        case MessageType.AddLogged: {
          const multiId = reader.u8();
          const msgId = reader.u16();
          const messageName = reader.str(size - 3);
          const definition = definitions.get(messageName);
          if (definition) {
            subscriptions.set(msgId, { ...definition, multiId });
          }
          break;
        }
        case MessageType.Log:
        case MessageType.LogTagged: {
          const isTagged = type === MessageType.LogTagged;
          const logLevel = reader.u8();
          if (isTagged) {
            reader.u16(); // tag, unused
          }
          const timestamp = reader.u64();
          const message = reader.str(size - (isTagged ? 11 : 9));
          logMessages.push({ level: logLevel, timeSec: Number(timestamp) / US_PER_SEC, message });
          logLevelCounts.set(logLevel, (logLevelCounts.get(logLevel) ?? 0) + 1);
          break;
        }
        case MessageType.Data: {
          const msgId = reader.u16();
          dataMessageCounts.set(msgId, (dataMessageCounts.get(msgId) ?? 0) + 1);
          const subscription = subscriptions.get(msgId);
          const actualSize = size - 2;
          if (subscription && !untrustedMsgIds.has(msgId)) {
            let tsOffset = timestampOffsetCache.get(msgId);
            if (tsOffset == undefined) {
              const offset = computeTimestampOffset(subscription, definitions);
              if (offset == undefined || offset + 8 > actualSize) {
                untrustedMsgIds.add(msgId);
              } else {
                tsOffset = offset;
                timestampOffsetCache.set(msgId, tsOffset);
              }
            }
            if (tsOffset != undefined) {
              // Still within the range already ensured above, so this is a
              // plain synchronous read.
              reader.seekTo(bodyStart + 2 + tsOffset);
              const ts = reader.u64();
              if (ts >= 0n && ts <= MAX_SANE_TIMESTAMP_US) {
                currentUs = ts;
                if (dataMinUs == undefined || ts < dataMinUs) {
                  dataMinUs = ts;
                }
                if (dataMaxUs == undefined || ts > dataMaxUs) {
                  dataMaxUs = ts;
                }
              }

              // A GPS fix's own reported UTC time, compared against this same
              // message's boot-relative timestamp just above, gives the one
              // reference point "wall clock" display needs — only look until
              // each preferred topic name has yielded one valid sample.
              if (GPS_UTC_TOPICS.includes(subscription.name)) {
                gpsTopicSeen = true;
                if (!gpsUtcOffsetByTopic.has(subscription.name)) {
                  let utcFieldOffset = gpsUtcFieldOffsetCache.get(msgId);
                  if (utcFieldOffset == undefined && !gpsUtcFieldOffsetCache.has(msgId)) {
                    utcFieldOffset = computeFieldOffset(subscription, definitions, "time_utc_usec", "uint64_t");
                    gpsUtcFieldOffsetCache.set(msgId, utcFieldOffset);
                  }
                  if (utcFieldOffset != undefined && utcFieldOffset + 8 <= actualSize) {
                    reader.seekTo(bodyStart + 2 + utcFieldOffset);
                    const utcUs = reader.u64();
                    if (utcUs > 0n) {
                      gpsNonzeroUtcSeen = true;
                      const utcMs = utcUs / 1000n;
                      if (utcMs >= MIN_SANE_UTC_MS && utcMs < MAX_SANE_UTC_MS) {
                        gpsUtcOffsetByTopic.set(subscription.name, utcUs - ts);
                      }
                    }
                  }
                }
              }
            }
          }
          break;
        }
        case MessageType.Dropout: {
          // duration-only message: no timestamp of its own, so it's
          // attributed to the last real Data message's time seen before it —
          // matches how a mid-flight parameter change's timeSec is derived
          // above.
          const durationMs = reader.u16();
          dropouts.push({ timeSec: Number(currentUs) / US_PER_SEC, durationMs });
          break;
        }
        // RemoveLogged, Synchronization, Unknown: nothing to extract.
      }
    } catch {
      // Fall through to reseek at bodyEnd regardless of what went wrong.
    }
    reader.seekTo(bodyEnd);
  }

  const timeRange: [number, number] | undefined =
    dataMinUs != undefined && dataMaxUs != undefined
      ? [Number(dataMinUs) / US_PER_SEC, Number(dataMaxUs) / US_PER_SEC]
      : undefined;

  // Prefer "sensor_gps" (current PX4) over "vehicle_gps_position" (the older
  // name it replaced) — see GPS_UTC_TOPICS.
  const gpsUtcOffsetUs = GPS_UTC_TOPICS.map((topic) => gpsUtcOffsetByTopic.get(topic)).find((v) => v != undefined);
  // Safe as a plain number: this is a small microsecond *difference* between
  // two uint64 timestamps, not an absolute one — nowhere near 2^53.
  const utcOffsetUsec = gpsUtcOffsetUs != undefined ? Number(gpsUtcOffsetUs) : undefined;
  const utcUnavailableReason =
    utcOffsetUsec != undefined
      ? undefined
      : !gpsTopicSeen
        ? "No GPS topic (sensor_gps or vehicle_gps_position) found in this log."
        : !gpsNonzeroUtcSeen
          ? "This log's GPS never reported a fix with a valid UTC time."
          : "This log's GPS-reported UTC time looks invalid (outside a plausible date range).";

  const untrustedTopics = [...untrustedMsgIds].map((msgId) => ({
    msgId,
    name: subscriptions.get(msgId)?.name ?? "?",
  }));

  return {
    ulogVersion,
    information,
    parameters,
    definitions,
    subscriptions,
    dataMessageCounts,
    messageCount,
    timeRange,
    dataSectionStart: dataSectionStart ?? dataEnd,
    dataSectionEnd: dataEnd,
    changesByParam,
    defaultsByParam,
    logMessages,
    utcOffsetUsec,
    utcUnavailableReason,
    messageTypeCounts,
    dropouts,
    fileHeaderTimestampUsec,
    hasDefaultParametersFlag,
    hasAppendedDataFlag,
    appendedDataOffset,
    logLevelCounts,
    untrustedTopics,
  };
}

/** One column's write target within a decoded field's raw value (a plain
 *  number for scalar fields, or `value[index]` for one element of an
 *  array field). */
interface ColumnTarget {
  column: Float64Array;
  index?: number;
}

/** A field worth decoding, alongside every column it feeds. */
interface FieldTask {
  byteOffset: number;
  field: Subscription["fields"][number];
  targets: ColumnTarget[];
}

export interface TopicColumnsResult {
  /** Timestamps in seconds, ascending. */
  times: Float64Array;
  /** One column per plottable field, same length as `times`. */
  columns: Map<string, Float64Array>;
}

function toNumber(value: unknown): number {
  switch (typeof value) {
    case "number":
      return value;
    case "bigint":
      return Number(value);
    case "boolean":
      return value ? 1 : 0;
    default:
      return NaN;
  }
}

/**
 * Fast, targeted single-pass scan that decodes only one topic's Data
 * messages into columnar arrays — the on-demand counterpart to
 * `scanUlogFile()`'s summary-only pass, and the reason `ulogEditorProvider.ts`
 * no longer needs `ulog.open()`/`readMessages()` at all (see this module's
 * docstring). Reuses `scan`'s already-parsed subscriptions/definitions and
 * jumps straight to `scan.dataSectionStart`, so the header/definitions
 * section is never re-parsed.
 *
 * Deliberately duplicates the field-skip/naming rules from
 * `plottableFields()` (ulogData.ts) rather than sharing a loop with it,
 * since here they need to run interleaved with byte-offset bookkeeping that
 * `plottableFields()` has no reason to compute. Keep the two in sync by hand
 * if PX4's field layout rules ever change.
 */
export async function scanTopicColumns(
  filelike: Filelike,
  scan: Pick<UlogFileScanResult, "subscriptions" | "definitions" | "dataMessageCounts" | "dataSectionStart" | "dataSectionEnd">,
  msgId: number,
): Promise<TopicColumnsResult> {
  const subscription = scan.subscriptions.get(msgId);
  if (!subscription) {
    throw new Error(`Unknown topic id ${msgId}`);
  }
  const capacity = scan.dataMessageCounts.get(msgId) ?? 0;

  const fieldTasks: FieldTask[] = [];
  const columns = new Map<string, Float64Array>();
  let timestampOffset: number | undefined;
  let curOffset = 0;
  for (const field of subscription.fields) {
    const size = fieldSize(field, scan.definitions);
    if (field.name === "timestamp") {
      if (field.type === "uint64_t") {
        timestampOffset = curOffset;
      }
    } else if (field.isComplex && field.arrayLength == undefined) {
      // One level of struct flattening — see plottableFields()'s matching
      // comment in ulogData.ts; keep the two in sync by hand.
      const nestedDef = scan.definitions.get(field.type);
      if (nestedDef) {
        let innerOffset = 0;
        for (const inner of nestedDef.fields) {
          const innerSize = fieldSize(inner, scan.definitions);
          if (!(inner.name.startsWith("_") || inner.isComplex || inner.type === "char" || inner.name === "timestamp")) {
            const targets: ColumnTarget[] = [];
            if (inner.arrayLength != undefined) {
              for (let i = 0; i < inner.arrayLength; i++) {
                const column = new Float64Array(capacity);
                columns.set(`${field.name}.${inner.name}[${i}]`, column);
                targets.push({ column, index: i });
              }
            } else {
              const column = new Float64Array(capacity);
              columns.set(`${field.name}.${inner.name}`, column);
              targets.push({ column });
            }
            fieldTasks.push({ byteOffset: curOffset + innerOffset, field: inner, targets });
          }
          innerOffset += innerSize * (inner.arrayLength ?? 1);
        }
      }
    } else if (!(field.name.startsWith("_") || field.isComplex || field.type === "char")) {
      const targets: ColumnTarget[] = [];
      if (field.arrayLength != undefined) {
        for (let i = 0; i < field.arrayLength; i++) {
          const column = new Float64Array(capacity);
          columns.set(`${field.name}[${i}]`, column);
          targets.push({ column, index: i });
        }
      } else {
        const column = new Float64Array(capacity);
        columns.set(field.name, column);
        targets.push({ column });
      }
      fieldTasks.push({ byteOffset: curOffset, field, targets });
    }
    curOffset += size * (field.arrayLength ?? 1);
  }

  const times = new Float64Array(capacity);
  let n = 0;

  // No usable timestamp field (matches `untrustedMsgIds` in scanUlogFile
  // above) — nothing we can plot against, return the (empty) shape rather
  // than guessing at row order.
  if (timestampOffset != undefined && capacity > 0) {
    await filelike.open();
    const fileSize = filelike.size();
    const reader = new FastReader(filelike, fileSize, scan.dataSectionStart);
    const dataEnd = Math.min(scan.dataSectionEnd, fileSize);

    while (dataEnd - reader.position() >= 3 && n < capacity) {
      if (!reader.hasAvailable(3)) {
        await reader.ensure(3);
      }
      const size = reader.u16();
      const type = reader.u8();
      const bodyStart = reader.position();
      const bodyEnd = bodyStart + size;
      if (bodyEnd > dataEnd) {
        break;
      }
      if (type === MessageType.Data) {
        if (!reader.hasAvailable(size)) {
          await reader.ensure(size);
        }
        const candidateMsgId = reader.u16();
        if (candidateMsgId === msgId) {
          const payloadStart = bodyStart + 2;
          const view = reader.rawView();
          const base = payloadStart - reader.bufferStart();
          if (base + timestampOffset + 8 <= view.byteLength) {
            times[n] = Number(view.getBigUint64(base + timestampOffset, true)) / US_PER_SEC;
            for (const task of fieldTasks) {
              const raw = parseBasicFieldValue(task.field, view, base + task.byteOffset);
              for (const target of task.targets) {
                target.column[n] = toNumber(target.index == undefined ? raw : (raw as number[])[target.index]);
              }
            }
            n++;
          }
        }
      }
      reader.seekTo(bodyEnd);
    }
  }

  if (n === capacity) {
    return { times, columns };
  }
  // Fewer messages than dataMessageCounts promised (e.g. a trailing
  // truncated message) — trim to the actual count.
  const trimmed = new Map<string, Float64Array>();
  for (const [name, column] of columns) {
    trimmed.set(name, column.slice(0, n));
  }
  return { times: times.slice(0, n), columns: trimmed };
}

/** A single field to reconstruct into a record, with the byte offset it
 *  decodes from within each Data message. `isString` fields are the `char[N]`
 *  strings; the rest are the numeric identity/type siblings below, formatted
 *  as decimal text so they can share the same record. */
interface StringFieldTask {
  name: string;
  field: Subscription["fields"][number];
  byteOffset: number;
  isString: boolean;
}

/** Cap on distinct whole records tracked, so a pathological topic that writes
 *  a unique string tuple every message can't grow an unbounded Map. A real
 *  device topic enumerates at most a few dozen distinct records; 128 is far
 *  past that while still bounding a per-sample-unique text topic. */
const MAX_DISTINCT_RECORDS = 128;

/** Numeric scalar siblings pulled into a string topic's records alongside its
 *  char fields — the identity/type metadata that names each device. Notably
 *  device_information's `device_id` (a packed bus/address/type bitfield that
 *  uniquely identifies a device) and `device_type`; `id` covers battery_info
 *  / cellular_status. These are stable per device, so including them never
 *  fragments records — measurement scalars (voltages, positions, …) are
 *  deliberately excluded, since those would make every sample a unique
 *  record. Matched case-insensitively. */
const ASSOCIATED_SCALAR_FIELDS = new Set(["device_id", "device_type", "id"]);

/** Formats a decoded scalar field value as the text stored in a record. */
function formatScalar(value: FieldPrimitive): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

/**
 * Turn a raw `char[N]` decode into the string it actually represents: cut at
 * the first NUL terminator (C-string convention — PX4 zero-fills the unused
 * tail) and drop any trailing whitespace/control bytes. Interior printable
 * content is left exactly as-is.
 */
function trimCString(raw: string): string {
  const nul = raw.indexOf("\u0000");
  const body = nul === -1 ? raw : raw.slice(0, nul);
  // Trailing whitespace and control/DEL bytes are fixed-width-buffer padding,
  // never meaningful content — e.g. a space-padded ADS-B callsign "SWA3060 ".
  // eslint-disable-next-line no-control-regex
  return body.replace(/[\s\u0000-\u001f\u007f]+$/, "");
}

/**
 * Reconstructs a topic's `char[N]` string fields — the text metadata (device
 * names, firmware/serial strings, …) that `scanTopicColumns` deliberately
 * skips because it isn't plottable. Same fast, targeted single-pass shape as
 * `scanTopicColumns` (jumps straight to `scan.dataSectionStart`, stops once
 * this topic's full message count is decoded), so a topic logged once at
 * boot — as device_information is — is found and returned almost immediately
 * rather than reading to end-of-file.
 *
 * Only top-level `char[N]` fields are reconstructed: that's where every real
 * PX4 string lives, and it keeps the byte-offset bookkeeping simple. Each
 * Data message becomes one whole record (all string fields decoded together),
 * and identical records are collapsed with a count — so the caller can show
 * each distinct device/entry once rather than N times, and can still see a
 * single field changing across a device's publications because the other
 * fields stay pinned to it within the record.
 */
export async function scanTopicStrings(
  filelike: Filelike,
  scan: Pick<UlogFileScanResult, "subscriptions" | "definitions" | "dataMessageCounts" | "dataSectionStart" | "dataSectionEnd">,
  msgId: number,
): Promise<TopicStrings> {
  const subscription = scan.subscriptions.get(msgId);
  if (!subscription) {
    throw new Error(`Unknown topic id ${msgId}`);
  }

  const tasks: StringFieldTask[] = [];
  let curOffset = 0;
  let charFieldCount = 0;
  for (const field of subscription.fields) {
    const size = fieldSize(field, scan.definitions);
    if (!field.name.startsWith("_")) {
      if (field.type === "char" && field.arrayLength != undefined) {
        tasks.push({ name: field.name, field, byteOffset: curOffset, isString: true });
        charFieldCount++;
      } else if (field.arrayLength == undefined && !field.isComplex && ASSOCIATED_SCALAR_FIELDS.has(field.name.toLowerCase())) {
        tasks.push({ name: field.name, field, byteOffset: curOffset, isString: false });
      }
    }
    curOffset += size * (field.arrayLength ?? 1);
  }
  // A topic with no char field carries no strings — even if it happened to
  // have a device_id/id scalar, there's nothing to show, so report none.
  if (charFieldCount === 0) {
    return { fieldNames: [], records: [], sampleCount: 0, truncated: false };
  }
  const fieldNames = tasks.map((t) => t.name);

  // Keyed by the record's values joined on NUL (which trimCString guarantees
  // no value contains), so insertion order is first-seen/chronological order.
  const recordsByKey = new Map<string, StringRecord>();
  let sampleCount = 0;
  let truncated = false;

  const capacity = scan.dataMessageCounts.get(msgId) ?? 0;
  let n = 0;
  if (capacity > 0) {
    await filelike.open();
    const fileSize = filelike.size();
    const reader = new FastReader(filelike, fileSize, scan.dataSectionStart);
    const dataEnd = Math.min(scan.dataSectionEnd, fileSize);

    while (dataEnd - reader.position() >= 3 && n < capacity) {
      if (!reader.hasAvailable(3)) {
        await reader.ensure(3);
      }
      const size = reader.u16();
      const type = reader.u8();
      const bodyStart = reader.position();
      const bodyEnd = bodyStart + size;
      if (bodyEnd > dataEnd) {
        break;
      }
      if (type === MessageType.Data) {
        if (!reader.hasAvailable(size)) {
          await reader.ensure(size);
        }
        const candidateMsgId = reader.u16();
        if (candidateMsgId === msgId) {
          const payloadStart = bodyStart + 2;
          const view = reader.rawView();
          const base = payloadStart - reader.bufferStart();
          const values: Record<string, string> = {};
          const keyParts: string[] = [];
          for (const task of tasks) {
            const raw = parseBasicFieldValue(task.field, view, base + task.byteOffset);
            const value = task.isString ? trimCString(raw as string) : formatScalar(raw);
            values[task.name] = value;
            keyParts.push(value);
          }
          const key = keyParts.join("\u0000");
          const existing = recordsByKey.get(key);
          if (existing) {
            existing.count++;
          } else if (recordsByKey.size < MAX_DISTINCT_RECORDS) {
            recordsByKey.set(key, { values, count: 1 });
          } else {
            truncated = true;
          }
          sampleCount++;
          n++;
        }
      }
      reader.seekTo(bodyEnd);
    }
  }

  return { fieldNames, records: [...recordsByKey.values()], sampleCount, truncated };
}
