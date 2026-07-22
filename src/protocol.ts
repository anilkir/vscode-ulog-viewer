/**
 * Message protocol shared between the extension host and the webview.
 *
 * All payloads must survive VS Code's postMessage serialization: JSON values
 * plus ArrayBuffer (supported natively for engines >= 1.57). No bigint.
 */

export interface FieldInfo {
  /** Expanded, plottable field name, e.g. "q[0]" or "z". */
  name: string;
  /** ULog primitive type, e.g. "float", "uint8_t". */
  type: string;
}

export interface TopicInfo {
  /** ULog subscription message id — unique key for data requests. */
  msgId: number;
  /** Display name, e.g. "sensor_accel [1]" for multi-instance topics. */
  name: string;
  /** Raw message definition name, e.g. "sensor_accel". */
  messageName: string;
  multiId: number;
  /** Number of data messages logged for this subscription. */
  count: number;
  fields: FieldInfo[];
}

export interface LogMessageInfo {
  /** Syslog-style level, 0 (emergency) .. 7 (debug). */
  level: number;
  /** Log time in seconds (same time base as plots, typically since boot). */
  timeSec: number;
  message: string;
}

export interface ParameterInfo {
  name: string;
  value: number;
  /**
   * PX4's recorded default value for this build, from the log's own 'Q'
   * (ParameterDefault) messages. Undefined if the log doesn't include them
   * (older firmware) or this specific parameter never got one.
   */
  defaultValue: number | undefined;
  /**
   * Values this parameter genuinely changed to mid-flight, in chronological
   * order (no-op re-writes of the already-current value are filtered out
   * before this reaches here — see meaningfulParameterChanges in
   * ulogData.ts). No timestamp: see changesByParam's own doc comment in
   * paramScan.ts for why the closest available proxy isn't trustworthy
   * enough to show as if it were exact.
   */
  changes: number[];
}

export interface MessageTypeCount {
  /** Human-readable name, e.g. "Data", "Information" — "Unknown (0x4a)" for
   *  a type byte the library itself doesn't recognize. */
  label: string;
  /** Raw type byte as it appears in the file. */
  typeCode: number;
  count: number;
}

export interface DropoutInfo {
  timeSec: number;
  durationMs: number;
}

export interface FormatDefinitionInfo {
  name: string;
  /** Raw declaration exactly as logged, e.g.
   *  "actuator_motors:uint64_t timestamp;float[4] control;...". */
  format: string;
}

export interface UntrustedTopicInfo {
  msgId: number;
  name: string;
}

export interface LogLevelCountInfo {
  /** Syslog-style level, 0 (emergency) .. 7 (debug) — same scale as
   *  LogMessageInfo.level, so the webview's existing level-label/badge
   *  logic for Messages applies here unchanged. */
  level: number;
  count: number;
}

export interface LogSummary {
  fileName: string;
  fileSizeBytes: number;
  ulogVersion: number;
  /** [start, end] of the data section in seconds. */
  timeRange: [number, number];
  durationSec: number;
  /** Information section key/value pairs, stringified for display. */
  info: [string, string][];
  parameters: ParameterInfo[];
  topics: TopicInfo[];
  logMessages: LogMessageInfo[];
  messageCount: number;
  /** `time_utc_usec - timestamp` from a GPS fix (sensor_gps, falling back to
   *  vehicle_gps_position), in microseconds — lets the plots' x-axis show
   *  real wall-clock time. Undefined if the log has no GPS topic, or the GPS
   *  never got a fix with a valid UTC time. */
  utcOffsetUsec: number | undefined;
  /** Why `utcOffsetUsec` is undefined — unset when it isn't. Shown as the
   *  disabled "Clock" time-axis option's tooltip. */
  utcUnavailableReason: string | undefined;
  /** Absolute byte offset where the data section begins — i.e. the size of
   *  the header/definitions section. */
  headerSizeBytes: number;
  /** Every message type seen, most frequent first. */
  messageTypeCounts: MessageTypeCount[];
  /** Every distinct message schema declared in the log, in declaration
   *  order (not every one necessarily has an active subscription — see
   *  `topics` above for that). */
  formatDefinitions: FormatDefinitionInfo[];
  /** Logged gaps in the data section, chronological. Empty (not "no data")
   *  means the log genuinely reported no dropouts. */
  dropouts: DropoutInfo[];
  /** The file header's own self-reported start time, in microseconds — raw
   *  and unvalidated; real loggers often leave this 0. */
  fileHeaderTimestampUsec: number;
  /** Whether this log's parameters carry recorded build-time defaults (see
   *  ParameterInfo.defaultValue) — decoded from the FlagBits message. */
  hasDefaultParametersFlag: boolean;
  /** Whether this file has a section appended after the data section. */
  hasAppendedDataFlag: boolean;
  /** Absolute byte offset of the appended section, if any. */
  appendedDataOffset: number | undefined;
  /** Subscriptions this scan couldn't resolve a trustworthy timestamp field
   *  for — typically non-PX4-native companion-computer topics with unusual
   *  layouts. */
  untrustedTopics: UntrustedTopicInfo[];
  /** Log/LogTagged message counts by syslog level. */
  logLevelCounts: LogLevelCountInfo[];
}

/**
 * A saved plotting layout — panels and which series each one plots. Series
 * are identified by topic name + multiId + field, *not* msgId: msgIds are
 * assigned per-file (in AddLogged declaration order), so they aren't stable
 * across different log files, which defeats the entire point of a saved
 * view being reusable across flights. Panel height and Y-range are also
 * captured so reloading a view restores the same framing, not just the same
 * series — X zoom deliberately isn't: it's absolute log-time seconds, which
 * doesn't mean anything comparable across logs with different start times
 * and durations, unlike height/Y-range which are just pixel/data-unit
 * properties of the plot itself. View-wide *display* toggles (time axis
 * unit, grid, points, step) are still deliberately excluded too — a saved
 * view is about *which data* to plot and how it was framed, not the rest of
 * the editor's chrome.
 */
export interface SavedViewSeriesSpec {
  topicName: string;
  multiId: number;
  field: string;
}

export interface SavedViewPanelSpec {
  series: SavedViewSeriesSpec[];
  /** Panel height in px, if it had been resized away from the default. */
  heightPx?: number;
  /** Manual Y-axis override, if one was set (absent means auto-ranged). */
  yRange?: [number, number];
}

export interface SavedView {
  name: string;
  panels: SavedViewPanelSpec[];
}

/** Webview -> extension host. */
export type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "getSeries"; msgId: number; field: string }
  | { type: "saveView"; panels: SavedViewPanelSpec[] }
  /** Overwrites an existing view in place — no name prompt, unlike
   *  "saveView" — used by the "Update View" action once the currently
   *  loaded view's plots have diverged from what's saved. */
  | { type: "updateView"; name: string; panels: SavedViewPanelSpec[] }
  | { type: "deleteView"; name: string }
  | { type: "renameView"; oldName: string }
  /** Re-sends the current "savedViews" list — each webview only gets pushed
   *  updates for saves/deletes/renames *it* triggered, so a view saved from
   *  a different log's tab needs an explicit refresh to show up here. */
  | { type: "refreshSavedViews" };

/** Extension host -> webview. */
export type HostToWebviewMessage =
  | { type: "summary"; summary: LogSummary }
  | { type: "loadError"; message: string }
  | { type: "savedViews"; views: SavedView[] }
  /** Sent alongside "savedViews" after a successful rename, so the webview
   *  can update anything referring to the view by its old name (e.g. the
   *  saved-view selector's lock) without having to diff two view lists. */
  | { type: "viewRenamed"; oldName: string; newName: string }
  /** Sent alongside "savedViews" after a successful "saveView", so the
   *  webview can lock the selector onto whatever name the user actually
   *  chose in the host-side prompt. */
  | { type: "viewSaved"; name: string }
  | {
      type: "series";
      msgId: number;
      field: string;
      /** Float64Array bytes: timestamps in seconds. */
      times: ArrayBuffer;
      /** Float64Array bytes: sample values (NaN where not representable). */
      values: ArrayBuffer;
    }
  | { type: "seriesError"; msgId: number; field: string; message: string };
