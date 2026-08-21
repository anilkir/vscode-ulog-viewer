/**
 * gps_dump decoding. PX4's gps_dump topic (enabled with GPS_DUMP_COMM) logs
 * the raw byte stream exchanged with the GNSS receiver: each sample carries
 * up to 79 bytes plus a `len` whose MSB is the direction (set = sent to the
 * device, clear = received from it) — the same convention pyulog's
 * ulog_extract_gps_dump splits its output files by. Reassembling the
 * fragments per receiver and direction (scanGpsDump in paramScan.ts) yields
 * the original protocol streams; this module splits those back into frames
 * (u-blox UBX, RTCM3 corrections, NMEA sentences, Septentrio SBF blocks) and
 * summarizes them as per-message-type counts, shaped as a TopicStrings so
 * the webview's existing string-field rendering can show them.
 */
import type { StringRecord, TopicStrings } from "./protocol";

/** One logged fragment's place in its reassembled stream: which byte offset
 *  it starts at, and the gps_dump sample timestamp it arrived with — the
 *  time source for every frame that starts inside it. */
export interface GpsDumpFragment {
  offset: number;
  timeSec: number;
}

/** One reassembled direction of one receiver's raw communication. */
export interface GpsDumpStream {
  /** Display name, e.g. "from device" or "GPS 1 · to device" — becomes the
   *  TopicStrings field this stream's frame counts are listed under. */
  key: string;
  bytes: Uint8Array;
  /** Fragment boundaries in `bytes`, offsets ascending. */
  fragments: GpsDumpFragment[];
}

/** Same bound as scanTopicStrings' MAX_DISTINCT_RECORDS: a healthy stream
 *  yields a few dozen distinct frame types at most, so a parse gone wrong
 *  (e.g. desynced framing producing near-random labels) gets capped instead
 *  of ballooning the summary. */
const MAX_DISTINCT_FRAMES = 128;

/* ---- u-blox UBX ------------------------------------------------------- */

/** Human names for the UBX class/message ids seen around PX4's u-blox driver
 *  (poll/config traffic to the device, nav/raw output from it). Anything
 *  else falls back to hex, so an unknown id is still distinguishable. */
const UBX_CLASSES: Record<number, { name: string; ids: Record<number, string> }> = {
  0x01: {
    name: "NAV",
    ids: {
      0x02: "POSLLH", 0x03: "STATUS", 0x04: "DOP", 0x06: "SOL", 0x07: "PVT",
      0x11: "VELECEF", 0x12: "VELNED", 0x14: "HPPOSLLH", 0x20: "TIMEGPS",
      0x21: "TIMEUTC", 0x22: "CLOCK", 0x30: "SVINFO", 0x35: "SAT", 0x36: "COV",
      0x3c: "RELPOSNED", 0x43: "SIG", 0x61: "EOE",
    },
  },
  0x02: { name: "RXM", ids: { 0x13: "SFRBX", 0x14: "MEASX", 0x15: "RAWX", 0x32: "RTCM" } },
  0x04: { name: "INF", ids: { 0x00: "ERROR", 0x01: "WARNING", 0x02: "NOTICE", 0x03: "TEST", 0x04: "DEBUG" } },
  0x05: { name: "ACK", ids: { 0x00: "NAK", 0x01: "ACK" } },
  0x06: {
    name: "CFG",
    ids: {
      0x00: "PRT", 0x01: "MSG", 0x04: "RST", 0x08: "RATE", 0x09: "CFG",
      0x13: "ANT", 0x16: "SBAS", 0x17: "NMEA", 0x24: "NAV5", 0x31: "TP5",
      0x39: "ITFM", 0x3e: "GNSS", 0x71: "TMODE3", 0x86: "PMS",
      0x8a: "VALSET", 0x8b: "VALGET", 0x8c: "VALDEL",
    },
  },
  0x0a: { name: "MON", ids: { 0x04: "VER", 0x09: "HW", 0x0b: "HW2", 0x28: "GNSS", 0x36: "COMMS", 0x37: "HW3", 0x38: "RF" } },
  0x0b: { name: "AID", ids: {} },
  0x0d: { name: "TIM", ids: { 0x01: "TP", 0x03: "TM2" } },
  0x10: { name: "ESF", ids: {} },
  0x13: { name: "MGA", ids: { 0x00: "GPS", 0x02: "GAL", 0x03: "BDS", 0x06: "GLO", 0x40: "INI", 0x60: "ACK" } },
  0x21: { name: "LOG", ids: {} },
  0x27: { name: "SEC", ids: { 0x03: "UNIQID" } },
};

function hex2(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0")}`;
}

function ubxLabel(cls: number, id: number): string {
  const clsEntry = UBX_CLASSES[cls];
  if (!clsEntry) {
    return `UBX ${hex2(cls)}-${hex2(id)}`;
  }
  return `UBX ${clsEntry.name}-${clsEntry.ids[id] ?? hex2(id)}`;
}

/* ---- RTCM3 ------------------------------------------------------------ */

/** Short descriptions for the RTCM3 message types RTK setups actually send
 *  (base position, MSM observations, biases); others show as a bare number. */
const RTCM3_NAMES: Record<number, string> = {
  1005: "station coordinates",
  1006: "station coordinates + height",
  1033: "receiver/antenna descriptors",
  1074: "GPS MSM4",
  1077: "GPS MSM7",
  1084: "GLONASS MSM4",
  1087: "GLONASS MSM7",
  1094: "Galileo MSM4",
  1097: "Galileo MSM7",
  1114: "QZSS MSM4",
  1117: "QZSS MSM7",
  1124: "BeiDou MSM4",
  1127: "BeiDou MSM7",
  1230: "GLONASS code-phase biases",
  4072: "u-blox proprietary",
};

function rtcm3Label(type: number): string {
  const name = RTCM3_NAMES[type];
  return name ? `RTCM3 ${type} (${name})` : `RTCM3 ${type}`;
}

/** CRC-24Q as RTCM3 uses it: generator 0x1864CFB, initial value 0 — NOT the
 *  OpenPGP CRC-24 variant, which shares the polynomial but seeds 0xB704CE
 *  (so the widely-quoted "123456789" -> 0x21CF02 check value doesn't apply
 *  here; crc24q([0x01]) = 0x864CFB, RTKLIB's tbl_CRC24Q[1], does). */
export function crc24q(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i]! << 16;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if (crc & 0x1000000) {
        crc ^= 0x1864cfb;
      }
    }
  }
  return crc & 0xffffff;
}

/* ---- Frame splitting --------------------------------------------------- */

/** Byte values that make up a plausible NMEA sentence body. */
function isNmeaChar(byte: number): boolean {
  return (byte >= 0x20 && byte <= 0x7e) || byte === 0x0d;
}

/**
 * Splits one reassembled stream into protocol frames, returning per-label
 * counts in first-seen order. Framing self-synchronizes the same way the
 * receivers themselves do: try to read a checksum-valid (UBX/RTCM3) or
 * structurally-valid (NMEA/SBF) frame at the current byte, otherwise treat
 * that byte as noise and move on one — so a dump that starts mid-frame, or
 * a dropped fragment in the middle, only costs the bytes actually lost.
 */
function parseStream(bytes: Uint8Array): {
  frames: { label: string; offset: number }[];
  noiseBytes: number;
  truncated: boolean;
} {
  const frames: { label: string; offset: number }[] = [];
  const distinct = new Set<string>();
  let noiseBytes = 0;
  let truncated = false;
  const n = bytes.length;

  let i = 0;
  // Every call site records before advancing i, so i is the frame's start.
  const record = (label: string) => {
    if (!distinct.has(label)) {
      if (distinct.size >= MAX_DISTINCT_FRAMES) {
        truncated = true;
        return;
      }
      distinct.add(label);
    }
    frames.push({ label, offset: i });
  };

  while (i < n) {
    const b0 = bytes[i]!;

    // u-blox UBX: B5 62, class, id, u16 LE length, payload, Fletcher-8.
    if (b0 === 0xb5 && i + 1 < n && bytes[i + 1] === 0x62) {
      if (i + 6 <= n) {
        const cls = bytes[i + 2]!;
        const id = bytes[i + 3]!;
        const len = bytes[i + 4]! | (bytes[i + 5]! << 8);
        const frameEnd = i + 6 + len + 2;
        if (frameEnd <= n) {
          let ckA = 0;
          let ckB = 0;
          for (let k = i + 2; k < i + 6 + len; k++) {
            ckA = (ckA + bytes[k]!) & 0xff;
            ckB = (ckB + ckA) & 0xff;
          }
          if (ckA === bytes[frameEnd - 2] && ckB === bytes[frameEnd - 1]) {
            record(ubxLabel(cls, id));
            i = frameEnd;
            continue;
          }
        } else if (len <= 4096) {
          // The stream ends mid-frame (logging stopped): the header is
          // present and sane, so count the message rather than dropping it.
          record(ubxLabel(cls, id));
          i = n;
          continue;
        }
      } else {
        // Too little left for even a header — a truncated tail, not noise.
        i = n;
        continue;
      }
    }

    // RTCM3: D3, 6 reserved zero bits + 10-bit length, payload, CRC-24Q.
    if (b0 === 0xd3 && i + 3 <= n && (bytes[i + 1]! & 0xfc) === 0) {
      const len = ((bytes[i + 1]! & 0x03) << 8) | bytes[i + 2]!;
      const frameEnd = i + 3 + len + 3;
      if (len >= 2 && frameEnd <= n) {
        const crc = crc24q(bytes, i, i + 3 + len);
        const stored = (bytes[frameEnd - 3]! << 16) | (bytes[frameEnd - 2]! << 8) | bytes[frameEnd - 1]!;
        if (crc === stored) {
          const type = (bytes[i + 3]! << 4) | (bytes[i + 4]! >> 4);
          record(rtcm3Label(type));
          i = frameEnd;
          continue;
        }
      } else if (len >= 2 && i + 5 <= n) {
        // Truncated tail, same reasoning as the UBX case above.
        const type = (bytes[i + 3]! << 4) | (bytes[i + 4]! >> 4);
        record(rtcm3Label(type));
        i = n;
        continue;
      }
    }

    // Septentrio SBF: "$@", u16 CRC, u16 block id, u16 length (multiple of 4).
    if (b0 === 0x24 && i + 8 <= n && bytes[i + 1] === 0x40) {
      const blockId = (bytes[i + 4]! | (bytes[i + 5]! << 8)) & 0x1fff;
      const len = bytes[i + 6]! | (bytes[i + 7]! << 8);
      if (len >= 8 && len % 4 === 0 && i + len <= n) {
        record(`SBF block ${blockId}`);
        i += len;
        continue;
      }
    }

    // NMEA: "$", printable ASCII, LF-terminated within the standard ~82-char
    // budget (a bit of slack for proprietary sentences).
    if (b0 === 0x24) {
      const limit = Math.min(n, i + 100);
      let end = -1;
      for (let k = i + 1; k < limit; k++) {
        const c = bytes[k]!;
        if (c === 0x0a) {
          end = k;
          break;
        }
        if (!isNmeaChar(c)) {
          break;
        }
      }
      if (end > i + 3) {
        let head = i + 1;
        while (head < end) {
          const c = bytes[head]!;
          if (c === 0x2c /* , */ || c === 0x2a /* * */ || c === 0x0d) {
            break;
          }
          head++;
        }
        record(`NMEA $${new TextDecoder().decode(bytes.subarray(i + 1, head))}`);
        i = end + 1;
        continue;
      }
    }

    noiseBytes++;
    i++;
  }

  return { frames, noiseBytes, truncated };
}

/**
 * Turns reassembled gps_dump streams into a TopicStrings: one field per
 * stream (direction/receiver), one record per distinct frame type with how
 * many frames of it were seen. The webview renders this with its per-field
 * string view, giving each direction its own most-frequent-first list.
 */
export function decodeGpsDumpStreams(streams: GpsDumpStream[], sampleCount: number): TopicStrings {
  const fieldNames: string[] = [];
  const records: StringRecord[] = [];
  let truncated = false;

  for (const stream of streams) {
    if (stream.bytes.length === 0) {
      continue;
    }
    fieldNames.push(stream.key);
    const { frames, noiseBytes, truncated: streamTruncated } = parseStream(stream.bytes);
    truncated ||= streamTruncated;
    const counts = new Map<string, number>();
    for (const frame of frames) {
      counts.set(frame.label, (counts.get(frame.label) ?? 0) + 1);
    }
    for (const [label, count] of counts) {
      records.push({ values: { [stream.key]: label }, count });
    }
    if (noiseBytes > 0) {
      records.push({ values: { [stream.key]: "unrecognized bytes" }, count: noiseBytes });
    }
  }

  return { fieldNames, records, sampleCount, truncated };
}

/** The fragment timestamp covering a frame that starts at `offset`: the last
 *  fragment starting at or before it (binary search — offsets ascending). */
function fragmentTimeAt(fragments: GpsDumpFragment[], offset: number): number {
  let lo = 0;
  let hi = fragments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fragments[mid]!.offset <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return fragments[lo]?.timeSec ?? 0;
}

/**
 * The plottable counterpart to `decodeGpsDumpStreams`: one column per
 * (frame type, direction) holding "seconds since that type's previous
 * frame", sampled at every frame arrival across all streams. Between
 * arrivals of a type the value ramps up linearly and drops back at the next
 * arrival, so a healthy stream draws a low sawtooth and an outage a tall
 * ramp whose peak is the gap length — before a type's first arrival (and
 * after its last) the ramp just keeps growing, which reads as exactly what
 * it is. Frame times are the timestamp of the gps_dump sample each frame
 * *starts* in — as fine-grained as the dump's own fragmenting allows.
 */
export function extractGpsDumpColumns(streams: GpsDumpStream[]): {
  times: Float64Array;
  columns: Map<string, Float64Array>;
} {
  interface FrameEvent {
    timeSec: number;
    column: string;
  }
  const events: FrameEvent[] = [];
  const columnNames: string[] = [];
  const seen = new Set<string>();
  for (const stream of streams) {
    if (stream.bytes.length === 0 || stream.fragments.length === 0) {
      continue;
    }
    const { frames } = parseStream(stream.bytes);
    for (const frame of frames) {
      const column = `${frame.label} [${stream.key}] gap (s)`;
      if (!seen.has(column)) {
        seen.add(column);
        columnNames.push(column);
      }
      events.push({ timeSec: fragmentTimeAt(stream.fragments, frame.offset), column });
    }
  }
  events.sort((a, b) => a.timeSec - b.timeSec);

  const n = events.length;
  const times = new Float64Array(n);
  const columns = new Map(columnNames.map((name) => [name, new Float64Array(n)]));
  // Ramps start at the dump's first frame, so "never arrived (yet)" grows
  // from the start of the dump rather than sitting at a meaningless 0.
  const startSec = events[0]?.timeSec ?? 0;
  const lastSeen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const t = events[i]!.timeSec;
    times[i] = t;
    for (const [name, column] of columns) {
      column[i] = t - (lastSeen.get(name) ?? startSec);
    }
    // Updated after writing row i, so a type's own arrival row still shows
    // the full interval it closed (the sawtooth's peak), not 0.
    lastSeen.set(events[i]!.column, t);
  }
  return { times, columns };
}
