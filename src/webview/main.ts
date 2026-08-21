import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./style.css";
import type {
  FieldInfo,
  HostToWebviewMessage,
  LogMessageInfo,
  LogSummary,
  ParameterInfo,
  SavedView,
  SavedViewPanelSpec,
  StringRecord,
  TopicInfo,
  TopicStrings,
  WebviewToHostMessage,
} from "../protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHostMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

const US_PER_SEC = 1e6;
const MAX_SERIES_PER_PANEL = 8;
/** How many string records/values to show before collapsing the remainder
 *  behind a click-to-reveal "+N more" (see the string-field rendering). */
const MAX_SHOWN_STRING_VALUES = 8;
/** Above this many distinct records — with no device-identity field to group
 *  them — a topic is treated as free-form text (not a device enumeration) and
 *  falls back to the compact per-field value view. */
const MAX_RECORD_VIEW = 24;
/** Identity fields, tried in order: a topic with one of these is a device
 *  enumeration, so records are grouped by it and a single field changing
 *  across a device's publications shows as a transition rather than a new
 *  device. `device_id` (device_information's unique hardware id — a packed
 *  bus/address/type bitfield) and `id` are numeric siblings the scan pulls
 *  in alongside the char fields; the serials are the char-field fallback.
 *  Matched case-insensitively against the record's field names. */
const IDENTITY_FIELD_NAMES = ["device_id", "id", "serial_number", "serial"];
const SERIES_COLOR_VARS = [
  "--ulog-series-1",
  "--ulog-series-2",
  "--ulog-series-3",
  "--ulog-series-4",
  "--ulog-series-5",
  "--ulog-series-6",
  "--ulog-series-7",
  "--ulog-series-8",
];
const LEVEL_NAMES = ["EMERG", "ALERT", "CRIT", "ERR", "WARN", "NOTICE", "INFO", "DEBUG"];
/** Distinct from SERIES_COLOR_VARS so a marker never coincidentally matches
 *  a plotted series' color. */
const MARKER_COLOR_VARS = ["--ulog-marker-1", "--ulog-marker-2", "--ulog-marker-3"];
/** All panel charts sharing this key have their x-axis pan/zoom kept in sync. */
const PLOT_SYNC_KEY = "ulogTimeSync";
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 640;
// Must stay comfortably above the header/y-range row + resizer + the chart's
// own floor in computeChartSize below — otherwise the drag lets a panel get
// smaller than what its own contents demand, and the chart (rendered at its
// floor size) visually overlaps the header instead of shrinking to fit.
const PANEL_MIN_HEIGHT = 180;
/** Set during a drag-to-reorder gesture; undefined the rest of the time. */
let draggedPanelId: number | undefined;

// Small monochrome icons for toolbar toggle buttons (inherit currentColor).
const ICON_POINTS =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M2 12 L6 6 L10 9 L14 3" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<circle cx="2" cy="12" r="1.5" fill="currentColor"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/>' +
  '<circle cx="10" cy="9" r="1.5" fill="currentColor"/><circle cx="14" cy="3" r="1.5" fill="currentColor"/></svg>';
const ICON_LINES =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M2 12 L6 6 L10 9 L14 3" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_ZERO =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<rect x="2" y="3" width="1.6" height="10" fill="currentColor"/>' +
  '<path d="M14 8 H5.5 M5.5 8 L9 4.5 M5.5 8 L9 11.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_GRID =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M2 6.5 H14 M2 10.5 H14 M6.5 2 V14 M10.5 2 V14" stroke="currentColor" stroke-width="1"/></svg>';
const ICON_STEP =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M2 12 H6 V7 H10 V4 H14" fill="none" stroke="currentColor" stroke-width="1.4" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_AUTORANGE =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M8 2 L8 14 M8 2 L5.5 4.5 M8 2 L10.5 4.5 M8 14 L5.5 11.5 M8 14 L10.5 11.5" ' +
  'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** "Layout with a left sidebar" glyph for the topic-list toggle — the left
 *  column is filled while the list is shown, hollow while it's hidden (see
 *  .sidebar-toggle-fill in style.css), same state language as VS Code's own
 *  sidebar toggle. */
const ICON_SIDEBAR =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<line x1="6.5" y1="2.5" x2="6.5" y2="13.5" stroke="currentColor" stroke-width="1.2"/>' +
  '<rect class="sidebar-toggle-fill" x="2.5" y="3.5" width="3" height="9" fill="currentColor"/></svg>';
const ICON_PREV =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NEXT =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CLOCK =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M8 4.5 V8 L10.5 9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MARKER =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M4 14 V2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M4 2 H12 L9.3 4.5 L12 7 H4" fill="currentColor"/></svg>';
/** ICON_MARKER's flag (nudged left to make room) with an × in the corner. */
const ICON_MARKER_CLEAR =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M3.5 14 V2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M3.5 2 H10.5 L8.1 4.25 L10.5 6.5 H3.5" fill="currentColor"/>' +
  '<path d="M9.8 10 L13.8 14 M13.8 10 L9.8 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
const ICON_PENCIL =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M11.5 2.5 L13.5 4.5 L5 13 L2.5 13.5 L3 11 Z" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M3 4.5 H13 M6 4.5 V2.8 H10 V4.5 M4.5 4.5 L5.2 13 H10.8 L11.5 4.5" fill="none" ' +
  'stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_GRIP =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<circle cx="5" cy="3" r="1.3" fill="currentColor"/><circle cx="11" cy="3" r="1.3" fill="currentColor"/>' +
  '<circle cx="5" cy="8" r="1.3" fill="currentColor"/><circle cx="11" cy="8" r="1.3" fill="currentColor"/>' +
  '<circle cx="5" cy="13" r="1.3" fill="currentColor"/><circle cx="11" cy="13" r="1.3" fill="currentColor"/></svg>';
const ICON_CHEVRON_UP =
  '<svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true">' +
  '<path d="M1 5 L5 1 L9 5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CHEVRON_DOWN =
  '<svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true">' +
  '<path d="M1 1 L5 5 L9 1" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

type TimeUnit = "seconds" | "minutes" | "wallclock";
type ParameterQuickFilter = "all" | "default" | "flight";

interface PlotSeries {
  /** Unique within a single panel: `${msgId}:${field}`. */
  key: string;
  msgId: number;
  field: string;
  label: string;
  /** Fixed color slot within this panel, assigned at add time and kept until removal. */
  slot: number;
  times: Float64Array;
  values: Float64Array;
}

interface PlotPanel {
  id: number;
  series: PlotSeries[];
  chart?: uPlot;
  containerEl: HTMLElement;
  headerEl: HTMLElement;
  chipsEl: HTMLElement;
  chartHostEl: HTMLElement;
  chartMountEl: HTMLElement;
  /** Manual Y-axis override; undefined means auto-ranged from the current data. */
  yRange: [number, number] | undefined;
  /**
   * Whatever Y range we last *intentionally* set (auto-computed or manual),
   * kept separately from `yRange` (which is only the manual override).
   * uPlot forces its own Y auto-recompute whenever a series is toggled via
   * its legend — `scales.y.auto: false` does NOT prevent this, since that
   * path calls `setScale(key, {min: null, max: null})` directly rather than
   * going through the normal auto-ranging gate. The `setSeries` hook uses
   * this to snap straight back to what we actually want to show.
   */
  lastYRange: [number, number] | undefined;
  yMinInput: HTMLInputElement;
  yMaxInput: HTMLInputElement;
  /** Floating labels showing the timestamp under the drag-to-zoom selection edges. */
  dragLabelStart?: HTMLElement;
  dragLabelEnd?: HTMLElement;
  /** This panel's own copy of every marker overlay (line + tag + value
   *  readout), rebuilt from `state.markers` any time this panel's chart is
   *  rebuilt, moved, or re-ranged. Torn down and recreated wholesale rather
   *  than diffed — there are only ever a handful of markers. */
  markerEls: Map<number, MarkerEls>;
  /** Legend height last accounted for in the canvas/legend height split
   *  (see computeChartSize) — compared against on every cursor move so a
   *  hover-triggered legend rewrap (live values make each entry wider,
   *  which can push one onto a new row) triggers a re-split instead of
   *  silently overflowing the panel's fixed height. */
  lastLegendHeight: number;
}

/** A user-placed vertical time marker, shared across every panel. `timeSec`
 *  is always the raw/absolute log time (unaffected by the zero-offset
 *  toggle), so a marker stays pinned to the same instant regardless of how
 *  that toggle is set. */
interface Marker {
  id: number;
  timeSec: number;
  color: string;
}

interface MarkerEls {
  hit: HTMLElement;
  tag: HTMLElement;
  timeLabel: HTMLElement;
  values: HTMLElement;
}

interface AppState {
  summary?: LogSummary;
  panels: PlotPanel[];
  nextPanelId: number;
  focusedPanelId: number | undefined;
  /** `${panelId}:${msgId}:${field}` requests in flight. */
  pending: Set<string>;
  /** Decoded `char[N]` string-field data, keyed by msgId — populated lazily
   *  the first time a string-bearing topic is expanded. */
  stringsCache: Map<number, TopicStrings>;
  /** msgIds whose string values have been requested and not yet returned. */
  pendingStrings: Set<number>;
  expandedTopics: Set<number>;
  /** Expanded struct-array instance groups in the topic sidebar (e.g.
   *  esc_status's `esc[3]`), keyed `${msgId}:${instancePrefix}` — the
   *  per-group analogue of `expandedTopics`. */
  expandedFieldGroups: Set<string>;
  topicFilter: string;
  /** Data tab's topic-list sidebar hidden to give the plots the full width —
   *  survives pane rebuilds (new file in the same editor) like the rest of
   *  this state, but deliberately not persisted beyond that. */
  sidebarCollapsed: boolean;
  parameterFilter: string;
  parameterQuickFilter: ParameterQuickFilter;
  currentTab: string;
  timeUnit: TimeUnit;
  /** IANA zone name used when timeUnit is "wallclock". Defaults to the
   *  browser's own local zone, editable via a text input next to the
   *  time-axis picker. */
  timezone: string;
  zeroOffset: boolean;
  showPoints: boolean;
  showLines: boolean;
  showGrid: boolean;
  stepped: boolean;
  markers: Marker[];
  nextMarkerId: number;
  /** Saved plotting layouts (panels + series), persisted host-side and
   *  reusable across different log files — see SavedView's own doc comment
   *  in protocol.ts for why series are keyed by topic name, not msgId. */
  savedViews: SavedView[];
  /** Name of the saved view currently loaded onto the plots, if any — while
   *  set, the saved-view selector locks to just this name (so an accidental
   *  re-selection can't silently blow away the loaded layout) until it's
   *  deleted or renamed. */
  lockedSavedViewName?: string;
}

const state: AppState = {
  panels: [],
  nextPanelId: 1,
  focusedPanelId: undefined,
  markers: [],
  nextMarkerId: 1,
  savedViews: [],
  pending: new Set(),
  stringsCache: new Map(),
  pendingStrings: new Set(),
  expandedTopics: new Set(),
  expandedFieldGroups: new Set(),
  topicFilter: "",
  sidebarCollapsed: false,
  parameterFilter: "",
  parameterQuickFilter: "all",
  currentTab: "data",
  timeUnit: "seconds",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  zeroOffset: false,
  showPoints: false,
  showLines: true,
  showGrid: true,
  stepped: false,
};

const app = document.getElementById("app") as HTMLElement;

// Rendered lazily once the summary arrives.
let topicListEl: HTMLElement;
let plotsColumnEl: HTMLElement;
let plotsEmptyEl: HTMLElement;
let plotStatusEl: HTMLElement;
let targetLabelEl: HTMLElement;
let savedViewSelect: HTMLSelectElement;
// Set only while the Manage Views dialog is open, so an incoming
// "savedViews" update can refresh its list live instead of going stale.
let manageViewsListEl: HTMLElement | undefined;
/** Holds whichever of Save View / Update View / Save as New currently
 *  apply — rebuilt by refreshSaveViewArea() any time the lock state or the
 *  loaded view's contents change. */
let saveAreaEl: HTMLElement;

// Info/Parameters/Messages panes can each hold thousands of rows (a large
// log easily has 1000+ parameters and 1000+ log messages) — building all of
// that DOM eagerly delayed showing the Data tab, which is what a user
// almost always wants first. Build those three lazily, on first visit.
const lazyPaneBuilders = new Map<string, () => HTMLElement>();
const builtPanes = new Map<string, HTMLElement>();

/** Where Ctrl+F lands per tab — each pane builder registers a callback that
 *  focuses its own search/filter input (the Data tab's first un-collapses
 *  the sidebar its input lives in). A tab with no entry (Replay — nothing
 *  text-based to search) leaves Ctrl+F unhandled. Cleared alongside
 *  builtPanes in buildUi(), so a new file's panes re-register fresh inputs. */
const searchFocusByTab = new Map<string, () => void>();

/** The common Ctrl+F registration: plain focus-and-select of one input. */
function registerSearchInput(tab: string, input: HTMLInputElement): void {
  searchFocusByTab.set(tab, () => {
    input.focus();
    input.select();
  });
}

document.addEventListener("keydown", (ev) => {
  // Plain Ctrl+F / Cmd+F only — modified combinations (e.g. Ctrl+Shift+F)
  // are VS Code's own, and must keep bubbling out of the webview.
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && ev.key.toLowerCase() === "f") {
    const focusSearch = searchFocusByTab.get(state.currentTab);
    if (focusSearch) {
      ev.preventDefault();
      focusSearch();
    }
  }
});

/* ---------------------------------------------------------------------- */
/* Small DOM helpers                                                       */
/* ---------------------------------------------------------------------- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text != undefined) {
    node.textContent = text;
  }
  return node;
}

/** Resolve any CSS color expression (vars, color-mix) to a canvas-safe color. */
const colorProbe = document.createElement("span");
colorProbe.style.display = "none";
document.body.appendChild(colorProbe);

function resolveColor(cssValue: string): string {
  colorProbe.style.color = cssValue;
  return getComputedStyle(colorProbe).color;
}

function seriesColor(slot: number): string {
  return resolveColor(`var(${SERIES_COLOR_VARS[slot] ?? SERIES_COLOR_VARS[0]})`);
}

function markerColor(slot: number): string {
  return resolveColor(`var(${MARKER_COLOR_VARS[slot % MARKER_COLOR_VARS.length]})`);
}

/* ---------------------------------------------------------------------- */
/* Formatting                                                              */
/* ---------------------------------------------------------------------- */

function formatDuration(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

function formatTimeTick(sec: number, decimals: number): string {
  const sign = sec < 0 ? "-" : "";
  const abs = Math.abs(sec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const rem = abs % 60;
  const secStr =
    decimals > 0
      ? rem.toFixed(decimals).padStart(3 + decimals, "0")
      : String(Math.floor(rem)).padStart(2, "0");
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, "0")}:${secStr}` : `${sign}${m}:${secStr}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-4)) {
    return value.toExponential(4);
  }
  return String(parseFloat(value.toPrecision(6)));
}

/** "seconds" mode is a plain decimal count of seconds; "minutes" mode is
 *  clock-style M:SS (or H:MM:SS past an hour), reusing `formatTimeTick`;
 *  "wallclock" converts to real time-of-day via `formatWallClock` below.
 *  `valueSec` is always in the chart's own (possibly zero-offset-shifted)
 *  coordinate space — reconstructing the true boot-relative time before
 *  adding the GPS-derived UTC offset is what the `+ offsetSec` below is for. */
function formatPlotTime(valueSec: number, unit: TimeUnit, decimals: number): string {
  if (unit === "wallclock") {
    const offsetSec = state.zeroOffset ? (state.summary?.timeRange[0] ?? 0) : 0;
    return formatWallClock(valueSec + offsetSec, decimals);
  }
  if (unit === "minutes") {
    return formatTimeTick(valueSec, decimals);
  }
  return valueSec.toFixed(decimals);
}

/** Every IANA zone name the engine knows, for the timezone dropdown — every
 *  option is inherently valid, so there's nothing to reject the way a free-
 *  text field would need to. Falls back to just the current zone on an
 *  older engine without `Intl.supportedValuesOf` (VS Code's bundled
 *  Chromium/V8 has had it for a while, but this keeps a missing dropdown
 *  from ever meaning a missing feature). */
function listTimeZones(): string[] {
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof supportedValuesOf === "function") {
    try {
      return supportedValuesOf("timeZone");
    } catch {
      // fall through
    }
  }
  return [state.timezone];
}

/** `rawBootRelativeSec` + the log's GPS-derived UTC offset gives an absolute
 *  instant, shown as a time-of-day in `state.timezone`. Sub-second digits
 *  only at higher zoom (`decimals` tracks the axis tick step elsewhere), to
 *  keep coarse ticks from being cluttered with a meaningless ".000". */
function formatWallClock(rawBootRelativeSec: number, decimals: number): string {
  const utcOffsetUsec = state.summary?.utcOffsetUsec;
  if (utcOffsetUsec == undefined) {
    return "—";
  }
  const epochMs = (rawBootRelativeSec * US_PER_SEC + utcOffsetUsec) / 1000;
  if (!Number.isFinite(epochMs)) {
    return "—";
  }
  const clampedDigits = Math.min(3, decimals);
  const fractionalSecondDigits = clampedDigits > 0 ? (clampedDigits as 1 | 2 | 3) : undefined;
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      timeZone: state.timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      ...(fractionalSecondDigits != undefined ? { fractionalSecondDigits } : {}),
    });
    return formatter.format(new Date(epochMs));
  } catch {
    return "invalid timezone";
  }
}

/** Just the "YYYY-MM-DD" portion of a wall-clock instant, in state.timezone
 *  — used alongside formatWallClock's own time-of-day where a bare time
 *  would be ambiguous (the Messages table's Clock column, which can span
 *  a log that crosses midnight). Built from individually-formatted parts,
 *  not the date's own locale-dependent order/separators, for a consistent
 *  prefix regardless of the reader's locale — same reasoning as
 *  `formatUtcStartTime`'s own ISO-style construction. Returns "" (not "—",
 *  since callers prepend this to formatWallClock's own placeholder) when
 *  this log has no GPS UTC reference. */
function formatWallClockDate(rawBootRelativeSec: number): string {
  const utcOffsetUsec = state.summary?.utcOffsetUsec;
  if (utcOffsetUsec == undefined) {
    return "";
  }
  const epochMs = (rawBootRelativeSec * US_PER_SEC + utcOffsetUsec) / 1000;
  if (!Number.isFinite(epochMs)) {
    return "";
  }
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: state.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(epochMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return "";
  }
}

/** The log's own start time as an absolute date, for the Info page — always
 *  UTC (unlike `formatWallClock`, which follows the Data tab's own
 *  user-configurable timezone), since this is a one-off fact about the log
 *  rather than an interactive axis, and UTC keeps it unambiguous regardless
 *  of who's reading it or where. */
function formatUtcStartTime(summary: LogSummary): string {
  if (summary.utcOffsetUsec == undefined) {
    return summary.utcUnavailableReason ?? "Not available (no GPS UTC reference in this log)";
  }
  const epochMs = (summary.timeRange[0] * US_PER_SEC + summary.utcOffsetUsec) / 1000;
  if (!Number.isFinite(epochMs)) {
    return "Not available (no GPS UTC reference in this log)";
  }
  return `${new Date(epochMs).toISOString().replace("T", " ").replace("Z", "")} UTC`;
}

function decimalsForStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) {
    return 3;
  }
  if (step >= 1) {
    return 0;
  }
  return Math.min(4, Math.ceil(-Math.log10(step)));
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

/**
 * Space-separated terms, each matched as a substring anywhere in `haystack`
 * (all must hit, any order) — e.g. "bat thr" matches "BAT_CRIT_THR" and
 * "BAT_LOW_THR". More forgiving than a single literal substring search
 * without the noise of full fuzzy/subsequence matching.
 */
function matchesSearchTerms(haystack: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const lower = haystack.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

/* ---------------------------------------------------------------------- */
/* Plot panels                                                             */
/* ---------------------------------------------------------------------- */

const CHART_PAD_X = 16;
const CHART_PAD_Y = 4;

function seriesKey(msgId: number, field: string): string {
  return `${msgId}:${field}`;
}

/** Resolvers for in-flight fetchSeriesAdHoc() calls, keyed the same way as
 *  plot panels' own pending requests — checked alongside (not instead of)
 *  the normal addSeries()/seriesError plot-panel handling in the "series"/
 *  "seriesError" message cases below. */
const adHocSeriesResolvers = new Map<
  string,
  { resolve: (data: { times: Float64Array; values: Float64Array }) => void; reject: (message: string) => void }
>();

/** Fetches one topic/field's full time series outside the normal plot-panel
 *  flow — e.g. the Replay tab, which needs a handful of specific fields
 *  up front rather than whatever the user happens to toggle on in a panel.
 *  A thin promise wrapper around the same getSeries/series/seriesError
 *  messages plot panels already use, so no protocol or host-side changes
 *  are needed. */
function fetchSeriesAdHoc(msgId: number, field: string): Promise<{ times: Float64Array; values: Float64Array }> {
  const key = seriesKey(msgId, field);
  return new Promise((resolve, reject) => {
    adHocSeriesResolvers.set(key, { resolve, reject });
    vscode.postMessage({ type: "getSeries", msgId, field });
  });
}

/** Returns `times` unchanged, or a shifted copy when the "start at 0" view option is on. */
function offsetTimes(times: Float64Array, offsetSec: number): Float64Array {
  if (offsetSec === 0) {
    return times;
  }
  const shifted = new Float64Array(times.length);
  for (let i = 0; i < times.length; i++) {
    shifted[i] = times[i]! - offsetSec;
  }
  return shifted;
}

function pendingKey(panelId: number, msgId: number, field: string): string {
  return `${panelId}:${msgId}:${field}`;
}

/** Index of the sample in `times` (sorted ascending) closest to `t`. */
function nearestIndex(times: Float64Array, t: number): number {
  if (times.length === 0) {
    return -1;
  }
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) {
    return lo - 1;
  }
  return lo;
}

function setPlotStatus(text: string): void {
  plotStatusEl.textContent = text;
}

/** What `updatePlotStatus` falls back to once nothing is pending — e.g. a
 *  "N series not found" warning from loading a saved view, which needs to
 *  survive the same series' own `getSeries` responses each re-triggering
 *  `updatePlotStatus` (and, without this, blanking the message the instant
 *  loading finishes rather than leaving it up for the user to actually
 *  read). Reset to "" by anything the user does afterward that calls
 *  through here, e.g. toggling a field. */
let stickyPlotStatus = "";

function updatePlotStatus(): void {
  setPlotStatus(state.pending.size > 0 ? "Loading data…" : stickyPlotStatus);
}

function updateTargetLabel(): void {
  const index = state.panels.findIndex((p) => p.id === state.focusedPanelId);
  targetLabelEl.textContent = index >= 0 ? `Adding to Plot ${index + 1}` : "";
}

function computeChartSize(panel: PlotPanel): { width: number; height: number } {
  const legend = panel.chartMountEl.querySelector<HTMLElement>(".u-legend");
  const legendHeight = legend?.offsetHeight ?? 0;
  panel.lastLegendHeight = legendHeight;
  // These floors previously (240x140) exceeded what PANEL_MIN_HEIGHT allowed
  // the panel to shrink to, so a fully-collapsed panel forced the chart to
  // render bigger than its own container — visually overlapping the header.
  // Small floors here just mean a tiny, cramped chart at the extreme, not a
  // broken layout. The height floor in particular has to stay low: with
  // several series, the live legend (hover appends each one's value) can
  // grow tall enough on its own that a bigger floor would force the canvas
  // past whatever room is actually left, overflowing the panel's border —
  // .chart-host's own overflow-y:auto is the backstop for however small
  // this floor still lets the canvas get.
  return {
    width: Math.max(100, panel.chartHostEl.clientWidth - CHART_PAD_X),
    height: Math.max(24, panel.chartHostEl.clientHeight - CHART_PAD_Y - legendHeight),
  };
}

function resizePanelChart(panel: PlotPanel): void {
  if (panel.chart && panel.chartHostEl.clientWidth > 0 && panel.chartHostEl.clientHeight > 0) {
    panel.chart.setSize(computeChartSize(panel));
  }
}

function resizeAllCharts(): void {
  for (const panel of state.panels) {
    resizePanelChart(panel);
  }
}

function renderPanelChips(panel: PlotPanel): void {
  panel.chipsEl.textContent = "";
  if (panel.series.length === 0) {
    panel.chipsEl.appendChild(el("span", "plot-panel-hint", "No fields selected"));
    return;
  }
  for (const s of panel.series) {
    const chip = el("span", "series-chip");
    chip.style.setProperty("--series-color", seriesColor(s.slot));
    chip.appendChild(el("span", "series-chip-dot"));
    chip.appendChild(el("span", "series-chip-label", s.label));
    const removeBtn = el("button", "series-chip-remove", "×");
    removeBtn.title = `Remove ${s.label}`;
    removeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeSeriesFromPanel(panel, s.key);
    });
    chip.appendChild(removeBtn);
    panel.chipsEl.appendChild(chip);
  }
}

function rebuildPanelChart(panel: PlotPanel, resetZoom = false): void {
  const prevXScale = !resetZoom ? panel.chart?.scales.x : undefined;
  const prevXMin = prevXScale?.min;
  const prevXMax = prevXScale?.max;
  panel.chart?.destroy();
  panel.chart = undefined;
  renderPanelChips(panel);

  if (panel.series.length === 0) {
    panel.chartHostEl.querySelector(".plot-empty")?.remove();
    panel.chartHostEl.appendChild(
      el("div", "plot-empty", "Select fields from the topic list on the left to plot them."),
    );
    return;
  }
  panel.chartHostEl.querySelector(".plot-empty")?.remove();

  const offsetSec = state.zeroOffset ? (state.summary?.timeRange[0] ?? 0) : 0;
  const tables = panel.series.map(
    (s) => [offsetTimes(s.times, offsetSec), s.values] as uPlot.AlignedData,
  );
  const data = tables.length === 1 ? tables[0]! : uPlot.join(tables);

  const axisColor = resolveColor("var(--vscode-descriptionForeground)");
  const gridColor = resolveColor("color-mix(in srgb, var(--vscode-foreground) 12%, transparent)");
  const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
  const axisFont = `11px ${fontFamily}`;
  const grid = { show: state.showGrid, stroke: gridColor, width: 1 };
  const ticks = { stroke: gridColor, width: 1, size: 5 };
  const unit = state.timeUnit;
  const unitLabel = unit === "wallclock" ? state.timezone : unit === "minutes" ? "m:ss" : "s";

  const options: uPlot.Options = {
    ...computeChartSize(panel),
    // y.auto:false — otherwise uPlot re-fits the Y scale on its own any
    // time X gets zoomed or a series' visibility changes (e.g. clicking its
    // legend entry), independent of anything we do. Y range is meant to be
    // entirely under our own control (see the preserve-on-rebuild logic
    // above, and applyYRange/autoRangeY).
    scales: { x: { time: false }, y: { auto: false } },
    series: [
      {
        label: `time (${unitLabel})`,
        value: (_u, v) => (v == null ? "—" : formatPlotTime(v, unit, 3)),
      },
      ...panel.series.map((s) => ({
        label: s.label,
        stroke: seriesColor(s.slot),
        // 0 draws no visible line at all (uPlot's own idiom for a
        // points-only series) — independent of showPoints, so turning both
        // off just means an empty-looking chart, same as the other toggles.
        width: state.showLines ? 2 : 0,
        spanGaps: true,
        // Zero-order hold: flat until the next sample, then a vertical step —
        // matches how a sampled/discrete signal actually changed, instead of
        // interpolating a slope between two readings that never existed.
        paths: state.stepped ? uPlot.paths.stepped!({ align: 1 }) : undefined,
        // Explicit fill/stroke/size: leaving these unset lets a dense
        // cluster of markers (uPlot's own fallback point styling) visually
        // paint over other series' lines underneath them.
        points: { show: state.showPoints, size: 5, width: 1, stroke: seriesColor(s.slot), fill: seriesColor(s.slot) },
        value: (_u: uPlot, v: number | null) => (v == null ? "—" : formatNumber(v)),
      })),
    ],
    axes: [
      {
        stroke: axisColor,
        font: axisFont,
        // Separate objects per axis: uPlot resolves/caches some config
        // properties onto the object it's given, so sharing one instance
        // across both axes risked cross-axis state bleed.
        grid: { ...grid },
        ticks: { ...ticks },
        // uPlot's own default (50) assumes a much larger tick font than our
        // 11px — that was the bulk of the visible gap between the plot area
        // and the legend below it. One line of small text plus its tick
        // mark comfortably fits in a good deal less; the extra few px past
        // that (rather than the tightest possible fit) is deliberate
        // breathing room above the legend, not leftover slack.
        size: 30,
        values: (_u, splits) => {
          const step = splits.length > 1 ? (splits[1] ?? 0) - (splits[0] ?? 0) : 1;
          const decimals = decimalsForStep(step);
          return splits.map((t) => (t == null ? "" : formatPlotTime(t, unit, decimals)));
        },
      },
      {
        stroke: axisColor,
        font: axisFont,
        grid: { ...grid },
        ticks: { ...ticks },
        size: 60,
      },
    ],
    cursor: {
      drag: { x: true, y: false },
      // Bigger than the (smaller, series-colored) static points shown when
      // "show points" is on, so the hovered one is still clearly distinct —
      // but in its own series' color, not a fixed color shared by all lines.
      points: {
        size: 9,
        width: 2,
        stroke: (_u, seriesIdx) => seriesColor(panel.series[seriesIdx - 1]?.slot ?? 0),
        fill: (_u, seriesIdx) => seriesColor(panel.series[seriesIdx - 1]?.slot ?? 0),
      },
      // Keep pan/zoom and crosshair position aligned across every panel so
      // relationships between different signals are easy to read off.
      sync: { key: PLOT_SYNC_KEY, scales: ["x", null] },
    },
    legend: { live: true },
    hooks: {
      // uPlot's legend click (toggling a series' visibility) forces its own
      // Y auto-recompute via a direct setScale(key, {min:null, max:null})
      // call — scales.y.auto:false does NOT gate this path, it's a separate
      // hardcoded behavior in uPlot's setSeries. Snap straight back to
      // whatever range we actually want shown.
      setSeries: [
        (u) => {
          if (panel.lastYRange) {
            u.setScale("y", { min: panel.lastYRange[0], max: panel.lastYRange[1] });
          }
        },
      ],
      // Zoom/pan (drag-to-zoom, wheel, or Reset zoom) all go through
      // setScale, including ones propagated here from another panel via the
      // cursor sync above — repositioning markers on every call keeps them
      // pinned to their own time rather than sliding with the view.
      setScale: [
        (_u, key) => {
          if (key === "x") {
            for (const marker of state.markers) {
              updateMarkerVisual(panel, marker);
            }
          }
        },
      ],
      // The live legend (legend.live: true) appends each series' value at
      // the hovered point, widening every entry — with enough series this
      // can wrap an extra row that computeChartSize() never reserved room
      // for, since it was last measured against the value-less resting
      // legend. Re-split canvas/legend height whenever hovering actually
      // changes the legend's rendered height, rather than letting the new
      // row overflow past the panel's (fixed-height) border.
      setCursor: [
        () => {
          const legend = panel.chartMountEl.querySelector<HTMLElement>(".u-legend");
          if ((legend?.offsetHeight ?? 0) !== panel.lastLegendHeight) {
            resizePanelChart(panel);
          }
        },
      ],
    },
  };

  panel.chart = new uPlot(options, data, panel.chartMountEl);
  if (prevXMin != undefined && prevXMax != undefined) {
    panel.chart.setScale("x", { min: prevXMin, max: prevXMax });
  }
  panel.dragLabelStart = createDragLabel("drag-label-start");
  panel.dragLabelEnd = createDragLabel("drag-label-end");
  panel.chart.over.appendChild(panel.dragLabelStart);
  panel.chart.over.appendChild(panel.dragLabelEnd);
  setupDragLabelTracking(panel);
  setupCursorHoverClass(panel);
  renderMarkersForPanel(panel);
  // A manual override (`panel.yRange`) is preserved on its own regardless of
  // why we got rebuilt. Otherwise, auto-range fresh from whatever's actually
  // plotted now — for cosmetic-only rebuilds (grid/points/time-unit/zero-
  // offset toggles) the series values haven't changed, so this reproduces
  // the same range; for an added/removed series it correctly grows or
  // shrinks to fit what's now on the chart instead of staying pinned to a
  // stale range from before the change.
  applyYRange(panel);
  // The legend height is only known after mount; correct the plot size once.
  requestAnimationFrame(() => resizePanelChart(panel));
}

function createDragLabel(variant: "drag-label-start" | "drag-label-end"): HTMLElement {
  const label = el("div", `zoom-drag-label ${variant}`);
  label.style.display = "none";
  return label;
}

/**
 * The synced cursor (`sync.scales: ["x", null]`) intentionally syncs the
 * vertical (time) line by matching x-values across panels, but the
 * horizontal line has no such shared meaning — different panels plot
 * different quantities on Y, so uPlot falls back to syncing it by relative
 * (%) position, which is meaningless clutter on any panel other than the
 * one actually being hovered. `.u-cursor-y` is toggled on/off by uPlot
 * itself (its own `.u-off` class), so we don't fight that — this just adds
 * an extra hide condition scoped to "not currently hovered".
 */
function setupCursorHoverClass(panel: PlotPanel): void {
  const over = panel.chart?.over;
  if (!over) {
    return;
  }
  over.addEventListener("mouseenter", () => panel.containerEl.classList.add("cursor-hover"));
  over.addEventListener("mouseleave", () => panel.containerEl.classList.remove("cursor-hover"));
}

const DRAG_LABEL_MIN_PX = 3;

/**
 * uPlot's own `.u-select` box already repaints live while dragging (via
 * internal cursor handling, not a public hook), but its `setSelect` hook
 * only fires once the drag completes — too late for a live timestamp label.
 * So we track the mouse ourselves, mirroring uPlot's own event wiring
 * (mousedown on the plotting area, mousemove/mouseup on the document so the
 * drag keeps tracking even past the chart's edge).
 */
function setupDragLabelTracking(panel: PlotPanel): void {
  const chart = panel.chart;
  if (!chart) {
    return;
  }
  const overEl = chart.over;
  let startPx = 0;

  const onMove = (ev: MouseEvent) => {
    const rect = overEl.getBoundingClientRect();
    const currentPx = Math.min(rect.width, Math.max(0, ev.clientX - rect.left));
    const leftPx = Math.min(startPx, currentPx);
    const rightPx = Math.max(startPx, currentPx);
    if (rightPx - leftPx < DRAG_LABEL_MIN_PX) {
      hideDragLabels(panel);
      return;
    }
    showDragLabels(panel, chart, leftPx, rightPx);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    hideDragLabels(panel);
  };
  overEl.addEventListener("mousedown", (ev) => {
    const rect = overEl.getBoundingClientRect();
    startPx = Math.min(rect.width, Math.max(0, ev.clientX - rect.left));
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

function showDragLabels(panel: PlotPanel, chart: uPlot, leftPx: number, rightPx: number): void {
  const { dragLabelStart: startLabel, dragLabelEnd: endLabel } = panel;
  if (!startLabel || !endLabel) {
    return;
  }
  const startVal = chart.posToVal(leftPx, "x");
  const endVal = chart.posToVal(rightPx, "x");
  startLabel.textContent = formatPlotTime(startVal, state.timeUnit, 3);
  endLabel.textContent = formatPlotTime(endVal, state.timeUnit, 3);
  startLabel.style.left = `${leftPx}px`;
  endLabel.style.left = `${rightPx}px`;
  startLabel.style.display = "block";
  endLabel.style.display = "block";
}

function hideDragLabels(panel: PlotPanel): void {
  if (panel.dragLabelStart) {
    panel.dragLabelStart.style.display = "none";
  }
  if (panel.dragLabelEnd) {
    panel.dragLabelEnd.style.display = "none";
  }
}

/* ---------------------------------------------------------------------- */
/* Time markers                                                           */
/* ---------------------------------------------------------------------- */

/** Repositions one marker's overlay in one panel and refreshes the values
 *  shown there — called after a drag, a zoom/pan (via the `setScale` hook),
 *  and once right after the overlay elements are first created. */
function updateMarkerVisual(panel: PlotPanel, marker: Marker): void {
  const chart = panel.chart;
  const els = panel.markerEls.get(marker.id);
  if (!chart || !els) {
    return;
  }
  const offsetSec = state.zeroOffset ? (state.summary?.timeRange[0] ?? 0) : 0;
  const displayTime = marker.timeSec - offsetSec;
  const px = chart.valToPos(displayTime, "x");
  // uPlot's setScale hook (which calls back into here) can also fire
  // mid-resize with a momentarily-zero client width before it settles —
  // leave visibility/position alone in that case rather than act on garbage.
  const chartWidth = chart.over.clientWidth;
  if (Number.isFinite(px) && chartWidth > 0) {
    // Zoomed/panned past this marker's time — hide the whole thing, not
    // just the line. The values box is offset a few px to whichever side
    // has room (see marker-flip-left below), so right at the edge of the
    // visible range that offset alone could shift an out-of-bounds box
    // back into view even though the line itself is gone.
    const outOfRange = px < 0 || px > chartWidth;
    els.hit.style.display = outOfRange ? "none" : "";
    els.tag.style.display = outOfRange ? "none" : "";
    els.values.style.display = outOfRange ? "none" : "";
    if (outOfRange) {
      return;
    }
    // The values readout sits off to whichever side of the line has more
    // room, rather than centered on top of it — centered would both cover
    // the chart right where the marker is and risk clipping off the panel
    // edge for markers placed near either side.
    els.values.classList.toggle("marker-flip-left", px > chartWidth / 2);
  }
  els.hit.style.left = `${px}px`;
  els.tag.style.left = `${px}px`;
  els.values.style.left = `${px}px`;
  els.timeLabel.textContent = formatPlotTime(displayTime, state.timeUnit, 3);

  els.values.textContent = "";
  if (panel.series.length === 0) {
    els.values.style.display = "none";
    return;
  }
  els.values.style.display = "";
  for (const s of panel.series) {
    const idx = nearestIndex(s.times, marker.timeSec);
    const value = idx >= 0 ? s.values[idx] : undefined;
    const row = el("div", "plot-marker-value-row");
    const dot = el("span", "plot-marker-value-dot");
    dot.style.background = seriesColor(s.slot);
    row.appendChild(dot);
    row.appendChild(el("span", undefined, `${s.label}: ${value == undefined ? "—" : formatNumber(value)}`));
    els.values.appendChild(row);
  }
}

function removeMarker(id: number): void {
  state.markers = state.markers.filter((m) => m.id !== id);
  renderAllMarkers();
}

/** No confirmation, same as "Clear all" for plots — markers are cheap to
 *  re-place, and each one still has its own × for one-at-a-time removal. */
function clearAllMarkers(): void {
  if (state.markers.length === 0) {
    return;
  }
  state.markers = [];
  renderAllMarkers();
}

/**
 * Snaps a marker to a real sample instead of leaving it at whatever
 * continuous time the cursor happens to be over. When the panel plots more
 * than one series, `clickYPos` (pixel Y within `panel.chart.over`) picks out
 * whichever series' curve is visually closest at that x — comparing in
 * pixel space, not data units, since two series can sit on wildly different
 * value scales where a raw numeric distance wouldn't mean anything
 * comparable. Falls back to the first series when there's no y position to
 * disambiguate with (e.g. the initial "+ Marker" placement) or only one
 * series to begin with. Returns a raw/absolute time, matching how markers
 * are always stored (see the Marker interface).
 */
function snapToNearestSampleTime(panel: PlotPanel, displayTimeSec: number, clickYPos?: number): number {
  const offsetSec = state.zeroOffset ? (state.summary?.timeRange[0] ?? 0) : 0;
  const rawTimeSec = displayTimeSec + offsetSec;
  let target = panel.series[0];
  if (target && clickYPos != undefined && panel.chart && panel.series.length > 1) {
    const chart = panel.chart;
    let bestDistPx = Infinity;
    for (const s of panel.series) {
      const idx = nearestIndex(s.times, rawTimeSec);
      const value = idx >= 0 ? s.values[idx] : undefined;
      if (value == undefined || !Number.isFinite(value)) {
        continue;
      }
      const distPx = Math.abs(chart.valToPos(value, "y") - clickYPos);
      if (distPx < bestDistPx) {
        bestDistPx = distPx;
        target = s;
      }
    }
  }
  if (!target) {
    return rawTimeSec;
  }
  const idx = nearestIndex(target.times, rawTimeSec);
  return idx >= 0 ? target.times[idx]! : rawTimeSec;
}

/** Mousedown-and-drag on a marker's hit zone repositions it — in every
 *  panel at once, since a marker is one shared instant in time, not a
 *  per-panel thing. Mirrors `setupPanelHeightResizer`'s document-level
 *  mousemove/mouseup tracking so the drag keeps working past the hit
 *  zone's own (narrow) bounds. Snaps to the nearest real sample (see
 *  `snapToNearestSampleTime`) rather than following the cursor continuously
 *  — a marker is meant to pin an actual data point, not an arbitrary instant
 *  that happens to fall between two samples. */
function setupMarkerDrag(panel: PlotPanel, marker: Marker, hit: HTMLElement): void {
  hit.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    // Otherwise this mousedown also reaches uPlot's own listener on the
    // parent `.u-over` and starts a drag-to-zoom selection underneath us.
    ev.stopPropagation();
    // uPlot's own hover crosshair/nearest-point highlight keeps tracking the
    // cursor throughout the drag regardless — it isn't gated by whether a
    // drag-to-zoom is in progress the way that gesture itself is, and
    // competes with the marker's own repositioning for the same mousemove,
    // reading as a laggy glitch. Hidden for the duration via CSS (see
    // `#app.dragging-marker` in style.css) rather than fought at the event
    // level, since uPlot doesn't expose an easy way to suspend it directly.
    // Toggled on `app`, not `document.body` — the theme-change
    // MutationObserver below watches body's class attribute specifically,
    // and would otherwise mistake this for a theme swap and rebuild every
    // chart (destroying and recreating every marker) on every drag start/end.
    app.classList.add("dragging-marker");
    const onMove = (moveEv: MouseEvent) => {
      const chart = panel.chart;
      if (!chart) {
        return;
      }
      const rect = chart.over.getBoundingClientRect();
      const px = Math.min(rect.width, Math.max(0, moveEv.clientX - rect.left));
      const py = moveEv.clientY - rect.top;
      const displayTime = chart.posToVal(px, "x");
      marker.timeSec = snapToNearestSampleTime(panel, displayTime, py);
      for (const p of state.panels) {
        updateMarkerVisual(p, marker);
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      app.classList.remove("dragging-marker");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** (Re)creates one panel's marker overlays from scratch. Safe to call
 *  whether or not this panel already had overlays: any previous elements
 *  (from before a full chart rebuild destroyed them, or from a stale
 *  marker list) are removed first. */
function renderMarkersForPanel(panel: PlotPanel): void {
  for (const els of panel.markerEls.values()) {
    els.hit.remove();
    els.tag.remove();
    els.values.remove();
  }
  panel.markerEls.clear();
  const chart = panel.chart;
  if (!chart) {
    return;
  }
  for (const marker of state.markers) {
    const hit = el("div", "plot-marker-hit");
    hit.style.setProperty("--marker-color", marker.color);
    hit.title = "Drag to move";

    const tag = el("div", "plot-marker-tag");
    tag.style.setProperty("--marker-color", marker.color);
    const timeLabel = el("span", "plot-marker-time");
    tag.appendChild(timeLabel);
    const removeBtn = el("button", "plot-marker-remove", "×");
    removeBtn.title = "Remove this marker";
    removeBtn.addEventListener("mousedown", (ev) => ev.stopPropagation());
    removeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeMarker(marker.id);
    });
    tag.appendChild(removeBtn);

    const values = el("div", "plot-marker-values");
    values.style.setProperty("--marker-color", marker.color);

    chart.over.appendChild(hit);
    chart.over.appendChild(tag);
    chart.over.appendChild(values);

    const els: MarkerEls = { hit, tag, timeLabel, values };
    panel.markerEls.set(marker.id, els);
    setupMarkerDrag(panel, marker, hit);
    updateMarkerVisual(panel, marker);
  }
}

function renderAllMarkers(): void {
  for (const panel of state.panels) {
    renderMarkersForPanel(panel);
  }
}

/** Adds a marker at the middle of whatever's currently visible, snapped to
 *  the nearest real sample (falling back to the log's full time range,
 *  unsnapped, if no panel has a chart yet — there's no series to snap to). */
function addMarker(): void {
  const panelWithChart = state.panels.find((p) => p.chart);
  const chart = panelWithChart?.chart;
  let timeSec: number;
  if (panelWithChart && chart) {
    const xScale = chart.scales.x;
    const displayCenter = ((xScale?.min ?? 0) + (xScale?.max ?? 0)) / 2;
    timeSec = snapToNearestSampleTime(panelWithChart, displayCenter);
  } else {
    const [start, end] = state.summary?.timeRange ?? [0, 1];
    timeSec = (start + end) / 2;
  }
  createMarkerAt(timeSec);
}

function createMarkerAt(timeSec: number): void {
  state.markers.push({
    id: state.nextMarkerId++,
    timeSec,
    color: markerColor(state.markers.length),
  });
  renderAllMarkers();
}

/** Min/max across all of a panel's plotted values, padded a bit past the true extremes. */
/** Auto-ranges Y to whatever's currently *visible* on the x-axis, not the
 *  whole series — reads the chart's own live x-scale (already the zoomed
 *  window, if any, since that's exactly what setScale("x", ...) updates)
 *  rather than tracking zoom state separately. Falls back to unbounded
 *  (the full series) if there's no chart yet to read a scale from. */
function computeAutoYRange(panel: PlotPanel): [number, number] {
  const xScale = panel.chart?.scales.x;
  const xMin = xScale?.min ?? -Infinity;
  const xMax = xScale?.max ?? Infinity;
  const offsetSec = state.zeroOffset ? (state.summary?.timeRange[0] ?? 0) : 0;
  let min = Infinity;
  let max = -Infinity;
  for (const s of panel.series) {
    for (let i = 0; i < s.values.length; i++) {
      const plottedTime = s.times[i]! - offsetSec;
      if (plottedTime < xMin || plottedTime > xMax) {
        continue;
      }
      const v = s.values[i]!;
      if (Number.isFinite(v)) {
        if (v < min) {
          min = v;
        }
        if (v > max) {
          max = v;
        }
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 1];
  }
  if (min === max) {
    const pad = Math.abs(min) * 0.2 || 1;
    return [min - pad, max + pad];
  }
  const pad = (max - min) * 0.2;
  return [min - pad, max + pad];
}

function formatYInputValue(v: number): string {
  return Number.isFinite(v) ? String(parseFloat(v.toPrecision(6))) : "";
}

/** Applies `panel.yRange` if the user has set one, otherwise auto-ranges from data. */
function applyYRange(panel: PlotPanel): void {
  if (!panel.chart) {
    return;
  }
  const [min, max] = panel.yRange ?? computeAutoYRange(panel);
  panel.lastYRange = [min, max];
  panel.chart.setScale("y", { min, max });
  panel.yMinInput.value = formatYInputValue(min);
  panel.yMaxInput.value = formatYInputValue(max);
}

function handleYRangeInputChange(panel: PlotPanel): void {
  const min = parseFloat(panel.yMinInput.value);
  const max = parseFloat(panel.yMaxInput.value);
  if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
    panel.yRange = [min, max];
    panel.lastYRange = [min, max];
    panel.chart?.setScale("y", { min, max });
    refreshSaveViewArea();
  }
}

function autoRangeY(panel: PlotPanel): void {
  panel.yRange = undefined;
  applyYRange(panel);
  refreshSaveViewArea();
}

function focusPanel(panelId: number): void {
  state.focusedPanelId = panelId;
  for (const panel of state.panels) {
    panel.containerEl.classList.toggle("focused", panel.id === panelId);
  }
  updateTargetLabel();
  refreshFieldButtons();
}

/** Reorders `state.panels` and the DOM to match, then renumbers "Plot N" labels. */
function movePanel(sourceId: number, targetId: number, before: boolean): void {
  const sourceIdx = state.panels.findIndex((p) => p.id === sourceId);
  if (sourceIdx < 0) {
    return;
  }
  const [sourcePanel] = state.panels.splice(sourceIdx, 1);
  const targetIdx = state.panels.findIndex((p) => p.id === targetId);
  const insertAt = targetIdx < 0 ? state.panels.length : before ? targetIdx : targetIdx + 1;
  state.panels.splice(insertAt, 0, sourcePanel!);

  for (const p of state.panels) {
    plotsColumnEl.appendChild(p.containerEl);
  }
  renumberPanels();
  // Panel order is part of a saved view's comparison (savedViewPanelsEqual
  // compares positionally), so reordering can turn a loaded-but-unchanged
  // view into a diverged one.
  refreshSaveViewArea();
}

function setupPanelDragAndDrop(panel: PlotPanel, handle: HTMLElement): void {
  handle.draggable = true;
  handle.addEventListener("dragstart", (ev) => {
    draggedPanelId = panel.id;
    if (ev.dataTransfer) {
      ev.dataTransfer.setData("text/plain", String(panel.id));
      ev.dataTransfer.effectAllowed = "move";
      // Use the whole panel (not just this tiny grip handle) as the drag
      // preview, anchored so it doesn't jump under the cursor — otherwise
      // the only feedback during a reorder drag is a near-invisible ghost
      // of the grip icon itself. Captured before dimming the source below,
      // so the dragged preview stays crisp while the original slot dims.
      const rect = panel.containerEl.getBoundingClientRect();
      ev.dataTransfer.setDragImage(panel.containerEl, ev.clientX - rect.left, ev.clientY - rect.top);
    }
    panel.containerEl.classList.add("dragging");
  });
  handle.addEventListener("dragend", () => {
    panel.containerEl.classList.remove("dragging");
    draggedPanelId = undefined;
  });

  panel.containerEl.addEventListener("dragover", (ev) => {
    if (draggedPanelId == undefined || draggedPanelId === panel.id) {
      return;
    }
    ev.preventDefault(); // allow drop
  });
  panel.containerEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    if (draggedPanelId == undefined || draggedPanelId === panel.id) {
      return;
    }
    const rect = panel.containerEl.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    movePanel(draggedPanelId, panel.id, before);
  });
}

// While dragging a panel-height resizer, the cursor stops being able to move
// any further once it reaches the bottom of the (possibly already-scrolled)
// .plots-scroll viewport — with enough panels stacked to fill the screen,
// that can happen well before the panel has grown as much as the user
// wanted. Auto-scrolling the container while the cursor sits near its edge
// (a standard drag-near-edge pattern) keeps the resize going regardless.
const RESIZE_AUTOSCROLL_EDGE_PX = 40;
const RESIZE_AUTOSCROLL_MAX_SPEED = 18;

function setupPanelHeightResizer(resizer: HTMLElement, panel: PlotPanel): void {
  let startY = 0;
  let startHeight = 0;
  let startScrollTop = 0;
  let scrollEl: HTMLElement | null = null;
  let lastClientY = 0;
  let autoScrollFrame: number | undefined;

  const applyHeight = () => {
    const scrollDelta = scrollEl ? scrollEl.scrollTop - startScrollTop : 0;
    const height = Math.max(PANEL_MIN_HEIGHT, startHeight + (lastClientY - startY) + scrollDelta);
    panel.containerEl.style.height = `${height}px`;
  };

  const autoScrollStep = () => {
    if (scrollEl) {
      const rect = scrollEl.getBoundingClientRect();
      const distFromBottom = Math.max(0, rect.bottom - lastClientY);
      const distFromTop = Math.max(0, lastClientY - rect.top);
      let speed = 0;
      if (distFromBottom < RESIZE_AUTOSCROLL_EDGE_PX) {
        speed = Math.round(RESIZE_AUTOSCROLL_MAX_SPEED * (1 - distFromBottom / RESIZE_AUTOSCROLL_EDGE_PX));
      } else if (distFromTop < RESIZE_AUTOSCROLL_EDGE_PX) {
        speed = -Math.round(RESIZE_AUTOSCROLL_MAX_SPEED * (1 - distFromTop / RESIZE_AUTOSCROLL_EDGE_PX));
      }
      if (speed !== 0) {
        scrollEl.scrollTop += speed;
        applyHeight();
      }
    }
    autoScrollFrame = requestAnimationFrame(autoScrollStep);
  };

  const onMove = (ev: MouseEvent) => {
    lastClientY = ev.clientY;
    applyHeight();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing-panel-height");
    resizer.classList.remove("active");
    if (autoScrollFrame != undefined) {
      cancelAnimationFrame(autoScrollFrame);
      autoScrollFrame = undefined;
    }
    refreshSaveViewArea();
  };
  resizer.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    startY = ev.clientY;
    lastClientY = ev.clientY;
    startHeight = panel.containerEl.getBoundingClientRect().height;
    scrollEl = resizer.closest<HTMLElement>(".plots-scroll");
    startScrollTop = scrollEl?.scrollTop ?? 0;
    document.body.classList.add("resizing-panel-height");
    resizer.classList.add("active");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    autoScrollFrame = requestAnimationFrame(autoScrollStep);
  });
}

interface YRangeField {
  wrap: HTMLElement;
  input: HTMLInputElement;
  stepUpBtn: HTMLElement;
  stepDownBtn: HTMLElement;
}

/** Custom up/down stepper instead of the browser's native spinner, which
 *  looks visibly out of place next to VS Code's own input chrome. */
function createYRangeField(labelText: string): YRangeField {
  const wrap = el("label", "yrange-field");
  wrap.appendChild(el("span", "yrange-field-label", labelText));

  const inputWrap = el("span", "yrange-input-wrap");
  const input = el("input", "yrange-input");
  input.type = "number";
  inputWrap.appendChild(input);

  const stepper = el("span", "yrange-stepper");
  const stepUpBtn = el("button", "yrange-step");
  stepUpBtn.type = "button";
  stepUpBtn.tabIndex = -1;
  stepUpBtn.innerHTML = ICON_CHEVRON_UP;
  const stepDownBtn = el("button", "yrange-step");
  stepDownBtn.type = "button";
  stepDownBtn.tabIndex = -1;
  stepDownBtn.innerHTML = ICON_CHEVRON_DOWN;
  stepper.appendChild(stepUpBtn);
  stepper.appendChild(stepDownBtn);
  inputWrap.appendChild(stepper);

  wrap.appendChild(inputWrap);
  return { wrap, input, stepUpBtn, stepDownBtn };
}

/** A step size that scales with the value's own magnitude (e.g. ~5 → 0.1,
 *  ~500 → 10), so +/- feels reasonable whether the axis is tiny or huge. */
function computeYRangeStep(value: number): number {
  const abs = Math.abs(value);
  if (abs === 0) {
    return 0.1;
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(abs)));
  return magnitude / 10;
}

function stepYRangeInput(panel: PlotPanel, input: HTMLInputElement, direction: 1 | -1): void {
  const current = parseFloat(input.value);
  const base = Number.isFinite(current) ? current : 0;
  input.value = formatYInputValue(base + direction * computeYRangeStep(base));
  handleYRangeInputChange(panel);
}

function createPanel(): PlotPanel {
  const id = state.nextPanelId++;
  const containerEl = el("div", "plot-panel");
  const headerEl = el("div", "plot-panel-header");
  const gripHandle = el("span", "plot-panel-grip");
  gripHandle.innerHTML = ICON_GRIP;
  gripHandle.title = "Drag to reorder";
  const indexLabel = el("span", "plot-panel-index", `Plot ${state.panels.length + 1}`);
  const chipsEl = el("div", "plot-panel-chips");

  const yGroup = el("div", "plot-panel-yrange");
  yGroup.title = "Y-axis range";
  const minField = createYRangeField("min");
  const maxField = createYRangeField("max");
  const { wrap: yMinWrap, input: yMinInput } = minField;
  const { wrap: yMaxWrap, input: yMaxInput } = maxField;
  yGroup.appendChild(yMinWrap);
  yGroup.appendChild(yMaxWrap);

  const removeBtn = el("button", "plot-panel-remove", "×");
  removeBtn.title = "Remove this plot";
  removeBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    removePanel(id);
  });
  headerEl.appendChild(gripHandle);
  headerEl.appendChild(indexLabel);
  headerEl.appendChild(chipsEl);
  headerEl.appendChild(yGroup);
  headerEl.appendChild(removeBtn);
  // On the whole panel, not just the header, so clicking into the chart body
  // to pick a series to plot next also focuses this panel.
  containerEl.addEventListener("click", () => focusPanel(id));

  const chartHostEl = el("div", "chart-host");
  const chartMountEl = el("div", "chart-mount");
  chartMountEl.style.width = "100%";
  chartMountEl.style.height = "100%";
  chartHostEl.appendChild(chartMountEl);

  const heightResizer = el("div", "plot-panel-resizer");
  heightResizer.title = "Drag to resize height";

  containerEl.appendChild(headerEl);
  containerEl.appendChild(chartHostEl);
  containerEl.appendChild(heightResizer);

  const panel: PlotPanel = {
    id,
    series: [],
    containerEl,
    headerEl,
    chipsEl,
    chartHostEl,
    chartMountEl,
    yRange: undefined,
    lastYRange: undefined,
    yMinInput,
    yMaxInput,
    markerEls: new Map(),
    lastLegendHeight: 0,
  };
  const autoBtn = makeIconButton(ICON_AUTORANGE, "Auto-range Y axis (±20%)", () => autoRangeY(panel));
  yGroup.appendChild(autoBtn);
  yMinInput.addEventListener("change", () => handleYRangeInputChange(panel));
  yMaxInput.addEventListener("change", () => handleYRangeInputChange(panel));
  minField.stepUpBtn.addEventListener("click", () => stepYRangeInput(panel, yMinInput, 1));
  minField.stepDownBtn.addEventListener("click", () => stepYRangeInput(panel, yMinInput, -1));
  maxField.stepUpBtn.addEventListener("click", () => stepYRangeInput(panel, yMaxInput, 1));
  maxField.stepDownBtn.addEventListener("click", () => stepYRangeInput(panel, yMaxInput, -1));
  setupPanelDragAndDrop(panel, gripHandle);
  setupPanelHeightResizer(heightResizer, panel);
  chartHostEl.addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    focusPanel(id);
    const items: { label: string; onClick: () => void }[] = [];
    const chart = panel.chart;
    if (chart) {
      const clientX = ev.clientX;
      const clientY = ev.clientY;
      items.push({
        label: "Add Marker Here",
        onClick: () => {
          const rect = chart.over.getBoundingClientRect();
          const px = Math.min(rect.width, Math.max(0, clientX - rect.left));
          const py = clientY - rect.top;
          createMarkerAt(snapToNearestSampleTime(panel, chart.posToVal(px, "x"), py));
        },
      });
    }
    items.push({ label: "Copy Plot as Image", onClick: () => void copyPlotAsImage(panel) });
    showContextMenu(ev.clientX, ev.clientY, items);
  });

  state.panels.push(panel);
  plotsColumnEl.appendChild(containerEl);
  new ResizeObserver(() => resizePanelChart(panel)).observe(chartHostEl);

  rebuildPanelChart(panel);
  renumberPanels();
  updatePlotsEmptyState();
  focusPanel(id);
  refreshSaveViewArea();
  return panel;
}

function removePanel(panelId: number): void {
  const index = state.panels.findIndex((p) => p.id === panelId);
  if (index < 0) {
    return;
  }
  const [panel] = state.panels.splice(index, 1);
  panel!.chart?.destroy();
  panel!.containerEl.remove();
  for (const key of [...state.pending]) {
    if (key.startsWith(`${panelId}:`)) {
      state.pending.delete(key);
    }
  }
  renumberPanels();
  updatePlotsEmptyState();
  if (state.focusedPanelId === panelId) {
    const fallback = state.panels[state.panels.length - 1];
    state.focusedPanelId = undefined;
    if (fallback) {
      focusPanel(fallback.id);
    } else {
      updateTargetLabel();
      refreshFieldButtons();
    }
  }
  refreshSaveViewArea();
}

function renumberPanels(): void {
  state.panels.forEach((panel, i) => {
    const label = panel.headerEl.querySelector(".plot-panel-index");
    if (label) {
      label.textContent = `Plot ${i + 1}`;
    }
  });
}

function updatePlotsEmptyState(): void {
  plotsEmptyEl.style.display = state.panels.length === 0 ? "flex" : "none";
}

function clearAllPlots(): void {
  for (const panel of [...state.panels]) {
    removePanel(panel.id);
  }
  // Otherwise the selector stays locked onto whatever view was loaded even
  // though its panels are all gone now — leaving "Update View" offering to
  // overwrite that saved view with this now-empty layout. Blanking the
  // select's own value first matters: refreshSavedViewSelect() otherwise
  // falls back to preserving whatever the dropdown currently shows.
  if (state.lockedSavedViewName) {
    state.lockedSavedViewName = undefined;
    savedViewSelect.value = "";
    refreshSavedViewSelect();
    refreshSaveViewArea();
  }
}

function resetAllZoom(): void {
  const [start, end] = state.summary?.timeRange ?? [0, 0];
  const min = state.zeroOffset ? 0 : start;
  const max = state.zeroOffset ? end - start : end;
  for (const panel of state.panels) {
    panel.chart?.setScale("x", { min, max });
  }
}

/**
 * @param resetZoom Pass true when the rebuild is due to a change that shifts
 * the underlying x *values* (only the "start at 0" offset does this — time
 * unit/grid/points only change formatting/rendering, not the data), so a
 * stale zoom window from before the shift isn't kept.
 */
function rebuildAllCharts(resetZoom = false): void {
  for (const panel of state.panels) {
    if (panel.series.length > 0) {
      rebuildPanelChart(panel, resetZoom);
    }
  }
}

function setShowPoints(value: boolean): void {
  state.showPoints = value;
  // A full rebuild, not an in-place series.points mutation + redraw(): the
  // latter was observed to sometimes leave one series' line un-rendered
  // when the grid was also on, seemingly from uPlot's redraw() not fully
  // reconciling per-series point paths against the shared axis grid state.
  // Rebuilding from scratch (like the grid/time-unit toggles already do)
  // doesn't have that problem.
  rebuildAllCharts();
}

function setShowLines(value: boolean): void {
  state.showLines = value;
  // Same full-rebuild reasoning as setShowPoints above.
  rebuildAllCharts();
}

/* ---------------------------------------------------------------------- */
/* Series management                                                       */
/* ---------------------------------------------------------------------- */

function removeSeriesAt(panel: PlotPanel, index: number): void {
  if (index < 0) {
    return;
  }
  panel.series.splice(index, 1);
  // In auto Y-range mode, rebuildPanelChart re-fits to whatever's left; a
  // manual override is preserved on its own via panel.yRange either way.
  rebuildPanelChart(panel);
  refreshFieldButtons();
  refreshSaveViewArea();
}

function toggleField(topic: TopicInfo, field: string): void {
  // Otherwise a stale "N series not found" message from a previous saved-
  // view load would resurface once this toggle's own request finishes and
  // updatePlotStatus falls back to it again.
  stickyPlotStatus = "";
  const panel = state.panels.find((p) => p.id === state.focusedPanelId) ?? createPanel();
  const key = seriesKey(topic.msgId, field);
  const pKey = pendingKey(panel.id, topic.msgId, field);
  if (state.pending.has(pKey)) {
    return;
  }
  const existing = panel.series.findIndex((s) => s.key === key);
  if (existing >= 0) {
    removeSeriesAt(panel, existing);
    return;
  }
  const pendingInPanel = [...state.pending].filter((k) => k.startsWith(`${panel.id}:`)).length;
  if (panel.series.length + pendingInPanel >= MAX_SERIES_PER_PANEL) {
    setPlotStatus(`Plot limit of ${MAX_SERIES_PER_PANEL} series reached — remove one first.`);
    return;
  }
  state.pending.add(pKey);
  updatePlotStatus();
  refreshFieldButtons();
  vscode.postMessage({ type: "getSeries", msgId: topic.msgId, field });
}

/* ---------------------------------------------------------------------- */
/* Saved views                                                             */
/* ---------------------------------------------------------------------- */

/** Panels with at least one series, as topic name/multiId/field triples —
 *  see SavedViewSeriesSpec's doc comment in protocol.ts for why not msgId. */
function captureCurrentView(): SavedViewPanelSpec[] {
  const panels: SavedViewPanelSpec[] = [];
  for (const panel of state.panels) {
    if (panel.series.length === 0) {
      continue;
    }
    const series = panel.series.map((s) => {
      const topic = state.summary?.topics.find((t) => t.msgId === s.msgId);
      return { topicName: topic?.messageName ?? "", multiId: topic?.multiId ?? 0, field: s.field };
    });
    panels.push({
      series,
      heightPx: Math.round(panel.containerEl.getBoundingClientRect().height),
      yRange: panel.yRange,
    });
  }
  return panels;
}

/** Replaces every current panel with the saved layout, matching each saved
 *  series back to this (possibly different) log's own topics by name +
 *  multiId rather than assuming the same msgIds apply. Series whose topic
 *  or field no longer exists here are silently skipped, not fatal — a
 *  saved view is meant to survive being applied to a log that doesn't
 *  share every topic the one it was saved from did. */
function loadSavedView(view: SavedView): void {
  const summary = state.summary;
  if (!summary) {
    return;
  }
  clearAllPlots();
  let missing = 0;
  for (const panelSpec of view.panels) {
    const panel = createPanel();
    if (panelSpec.heightPx) {
      panel.containerEl.style.height = `${panelSpec.heightPx}px`;
    }
    // Set before any series load: rebuildPanelChart's own applyYRange call
    // (triggered once each series' data arrives) already prefers a set
    // panel.yRange over auto-ranging, so this alone restores it.
    if (panelSpec.yRange) {
      panel.yRange = panelSpec.yRange;
    }
    for (const seriesSpec of panelSpec.series) {
      const topic = summary.topics.find(
        (t) => t.messageName === seriesSpec.topicName && t.multiId === seriesSpec.multiId,
      );
      if (!topic || !topic.fields.some((f) => f.name === seriesSpec.field)) {
        missing++;
        continue;
      }
      toggleField(topic, seriesSpec.field);
    }
  }
  stickyPlotStatus =
    missing > 0 ? `Loaded "${view.name}" — ${missing} series not found in this log.` : `Loaded "${view.name}".`;
  updatePlotStatus();
}

/** Panel height differences under this are treated as layout noise (box
 *  model/subpixel rounding), not a real resize — a plain reload-with-no-
 *  changes measured ~2px of drift on its own, and an intentional drag of
 *  the resizer handle moves things by far more than that. */
const HEIGHT_DIVERGENCE_TOLERANCE_PX = 4;

/** Compares by content, not identity — panel height is included (with a
 *  tolerance, see above) since it's captured and restored like everything
 *  else here, so a real resize is as much "a change to the view" as an
 *  added series or a new Y-range. */
function savedViewPanelsEqual(a: SavedViewPanelSpec[], b: SavedViewPanelSpec[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    const pa = a[i]!;
    const pb = b[i]!;
    if (pa.series.length !== pb.series.length) {
      return false;
    }
    for (let j = 0; j < pa.series.length; j++) {
      const sa = pa.series[j]!;
      const sb = pb.series[j]!;
      if (sa.topicName !== sb.topicName || sa.multiId !== sb.multiId || sa.field !== sb.field) {
        return false;
      }
    }
    const ya = pa.yRange;
    const yb = pb.yRange;
    if (!ya !== !yb) {
      return false;
    }
    if (ya && yb && (ya[0] !== yb[0] || ya[1] !== yb[1])) {
      return false;
    }
    const ha = pa.heightPx;
    const hb = pb.heightPx;
    if (ha != undefined && hb != undefined && Math.abs(ha - hb) > HEIGHT_DIVERGENCE_TOLERANCE_PX) {
      return false;
    }
  }
  return true;
}

/** Whether the currently loaded view's plots have diverged from what's
 *  actually saved under that name — false (nothing to update) whenever
 *  nothing is loaded, or the loaded name has since vanished from
 *  state.savedViews (e.g. deleted elsewhere). */
function isLoadedViewModified(): boolean {
  if (!state.lockedSavedViewName) {
    return false;
  }
  // A series is only in panel.series (and hence captureCurrentView()) once
  // its data has actually arrived — toggleField itself just marks it
  // pending. Right after loading a multi-series view, the panels exist but
  // are still momentarily empty while that data streams in, which would
  // otherwise look identical to "every series got removed". addSeries()
  // re-triggers this once each request lands, so it's safe to just wait.
  if (state.pending.size > 0) {
    return false;
  }
  const loaded = state.savedViews.find((v) => v.name === state.lockedSavedViewName);
  if (!loaded) {
    return false;
  }
  return !savedViewPanelsEqual(captureCurrentView(), loaded.panels);
}

/** Rebuilds the Save View / Update View / Save as New button(s) — call
 *  after anything that could change either the lock state or whether the
 *  loaded view's plots still match what's saved (series toggles, panel
 *  add/remove, Y-range changes, a "savedViews" update arriving). */
function refreshSaveViewArea(): void {
  saveAreaEl.textContent = "";
  if (!state.lockedSavedViewName) {
    const saveViewBtn = el("button", undefined, "Save View");
    saveViewBtn.title = "Save the current plots (panels + series) as a reusable named view";
    saveViewBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "saveView", panels: captureCurrentView() });
    });
    saveAreaEl.appendChild(saveViewBtn);
    return;
  }
  if (isLoadedViewModified()) {
    const lockedName = state.lockedSavedViewName;
    const updateBtn = el("button", undefined, "Update View");
    updateBtn.title = `Save these changes back to "${lockedName}"`;
    updateBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "updateView", name: lockedName, panels: captureCurrentView() });
    });
    saveAreaEl.appendChild(updateBtn);
  }
  const saveAsNewBtn = el("button", undefined, "Save as New");
  saveAsNewBtn.title = "Save the current plots as a new, separately named view";
  saveAsNewBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "saveView", panels: captureCurrentView() });
  });
  saveAreaEl.appendChild(saveAsNewBtn);
}

/** Rebuilds the saved-views <select> from state.savedViews, preserving the
 *  current selection if it's still present (e.g. right after a Save that
 *  didn't change which view is "current"). While a view is loaded
 *  (state.lockedSavedViewName), the selector instead locks to just that
 *  name — see the field's own doc comment for why. */
function refreshSavedViewSelect(): void {
  if (state.lockedSavedViewName && !state.savedViews.some((v) => v.name === state.lockedSavedViewName)) {
    // The loaded view was deleted (or renamed away) out from under us.
    state.lockedSavedViewName = undefined;
  }

  // Always shows every view, loaded one included — it used to lock down to
  // just the loaded name (no other options at all) to stop an accidental
  // click from silently blowing away the current plots, but that also blocks
  // the entirely reasonable "switch to a different view" action, with no
  // way back short of deleting the one that's loaded. The actual risk (an
  // in-progress, unsaved edit getting silently discarded) is now guarded
  // where selection is handled instead, only when it can actually happen.
  const previousValue = savedViewSelect.value;
  savedViewSelect.textContent = "";
  const placeholder = el(
    "option",
    undefined,
    state.savedViews.length === 0 ? "No saved views yet" : "Select a view",
  ) as HTMLOptionElement;
  placeholder.value = "";
  savedViewSelect.appendChild(placeholder);
  for (const view of state.savedViews) {
    const option = el("option", undefined, view.name) as HTMLOptionElement;
    option.value = view.name;
    savedViewSelect.appendChild(option);
  }
  const preferredValue = state.lockedSavedViewName ?? previousValue;
  savedViewSelect.value = state.savedViews.some((v) => v.name === preferredValue) ? preferredValue : "";
  refreshSaveViewArea();
}

/** Rebuilds the Manage Views dialog's row list in place, if it's currently
 *  open — called both when the dialog is first opened and whenever a
 *  "savedViews" update arrives, so a rename/delete's round trip to the host
 *  is reflected live instead of requiring the dialog to be reopened. */
function renderManageViewsList(): void {
  if (!manageViewsListEl) {
    return;
  }
  manageViewsListEl.textContent = "";
  if (state.savedViews.length === 0) {
    manageViewsListEl.appendChild(el("div", "manage-views-empty", "No saved views yet."));
    return;
  }
  for (const view of state.savedViews) {
    const row = el("div", "manage-view-row");
    const panelCount = view.panels.length;
    const nameGroup = el("div", "manage-view-name-group");
    nameGroup.appendChild(el("span", "manage-view-name", view.name));
    nameGroup.appendChild(
      el("span", "manage-view-meta", `${panelCount} plot${panelCount === 1 ? "" : "s"}`),
    );
    row.appendChild(nameGroup);
    const actions = el("div", "manage-view-actions");
    const renameBtn = makeIconButton(ICON_PENCIL, `Rename "${view.name}"`, () => {
      vscode.postMessage({ type: "renameView", oldName: view.name });
    });
    actions.appendChild(renameBtn);
    const deleteBtn = makeIconButton(ICON_TRASH, `Delete "${view.name}"`, () => {
      vscode.postMessage({ type: "deleteView", name: view.name });
    });
    deleteBtn.classList.add("manage-view-delete");
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    manageViewsListEl.appendChild(row);
  }
}

/** A small in-page yes/no modal — deliberately not window.confirm(): VS
 *  Code renders webview content inside a sandboxed iframe that doesn't
 *  grant `allow-modals`, so the browser's native confirm()/alert()/
 *  prompt() are silently blocked there (confirm() just returns false
 *  immediately, no dialog ever shown) even though they work fine in a
 *  plain, un-sandboxed test page — which is exactly why this went
 *  unnoticed until it was tried in a real VS Code window. Reuses the same
 *  .modal-backdrop/.modal-dialog markup as Manage Views, since that's
 *  just ordinary page content, not a native dialog API. */
function showConfirmDialog(message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = el("div", "modal-backdrop");
    const dialog = el("div", "modal-dialog confirm-dialog");
    const close = (result: boolean) => {
      backdrop.remove();
      resolve(result);
    };
    backdrop.addEventListener("click", (ev) => {
      if (ev.target === backdrop) {
        close(false);
      }
    });
    dialog.appendChild(el("div", "confirm-dialog-body", message));
    const actions = el("div", "confirm-dialog-actions");
    const cancelBtn = el("button", undefined, "Cancel");
    cancelBtn.addEventListener("click", () => close(false));
    actions.appendChild(cancelBtn);
    const confirmBtn = el("button", "primary", confirmLabel);
    confirmBtn.addEventListener("click", () => close(true));
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
  });
}

/** Opens a small modal overlay listing every saved view with per-row
 *  Rename/Delete actions — unlike the toolbar's Delete button, this isn't
 *  limited to whichever view happens to be loaded/selected right now. */
function openManageViewsDialog(): void {
  const backdrop = el("div", "modal-backdrop");
  backdrop.addEventListener("click", (ev) => {
    if (ev.target === backdrop) {
      closeDialog();
    }
  });
  const dialog = el("div", "modal-dialog");
  const header = el("div", "modal-header");
  header.appendChild(el("h3", "modal-title", "Manage Saved Views"));
  const closeBtn = el("button", "icon-btn modal-close-btn", "×");
  closeBtn.title = "Close";
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  manageViewsListEl = el("div", "manage-views-list");
  dialog.appendChild(manageViewsListEl);
  renderManageViewsList();

  const closeDialog = () => {
    manageViewsListEl = undefined;
    backdrop.remove();
  };
  closeBtn.addEventListener("click", closeDialog);

  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
}

function removeSeriesFromPanel(panel: PlotPanel, key: string): void {
  const index = panel.series.findIndex((s) => s.key === key);
  removeSeriesAt(panel, index);
}

function addSeries(msgId: number, field: string, times: Float64Array, values: Float64Array): void {
  // Find whichever panel is still waiting on this exact request (there's at
  // most one, since a field can only be toggled once per panel at a time).
  const key = seriesKey(msgId, field);
  const panel = state.panels.find((p) => state.pending.has(pendingKey(p.id, msgId, field)));
  if (!panel) {
    return; // stale response (panel removed, or series toggled off while loading)
  }
  state.pending.delete(pendingKey(panel.id, msgId, field));
  const usedSlots = new Set(panel.series.map((s) => s.slot));
  let slot = 0;
  while (usedSlots.has(slot) && slot < MAX_SERIES_PER_PANEL - 1) {
    slot++;
  }
  const topic = state.summary?.topics.find((t) => t.msgId === msgId);
  panel.series.push({
    key,
    msgId,
    field,
    label: `${topic?.name ?? msgId}.${field}`,
    slot,
    times,
    values,
  });
  updatePlotStatus();
  rebuildPanelChart(panel);
  refreshFieldButtons();
  refreshSaveViewArea();
}

function refreshFieldButtons(): void {
  const focused = state.panels.find((p) => p.id === state.focusedPanelId);
  for (const button of topicListEl.querySelectorAll<HTMLElement>(".field-btn")) {
    const msgId = Number(button.dataset.msgId);
    const field = button.dataset.field ?? "";
    const key = seriesKey(msgId, field);
    const active = focused?.series.find((s) => s.key === key);
    const pending = focused != undefined && state.pending.has(pendingKey(focused.id, msgId, field));
    button.classList.toggle("active", active != undefined);
    button.classList.toggle("pending", pending);
    if (active) {
      button.style.setProperty("--series-color", seriesColor(active.slot));
    } else {
      button.style.removeProperty("--series-color");
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Topic sidebar                                                           */
/* ---------------------------------------------------------------------- */

/** String fields of a topic that pass the current sidebar filter — the same
 *  name-based rule used for plottable fields (values aren't loaded until a
 *  topic is expanded, so they can't participate in the filter). */
function matchingStringFieldNames(topic: TopicInfo): string[] {
  const filter = state.topicFilter.trim();
  if (filter === "" || matchesSearchTerms(topic.name, filter)) {
    return topic.stringFields.map((f) => f.name);
  }
  return topic.stringFields.filter((f) => matchesSearchTerms(f.name, filter)).map((f) => f.name);
}

/** Requests a topic's string-field values once, the first time it's needed. */
function ensureStringsFetched(msgId: number): void {
  if (state.stringsCache.has(msgId) || state.pendingStrings.has(msgId)) {
    return;
  }
  state.pendingStrings.add(msgId);
  vscode.postMessage({ type: "getStrings", msgId });
  populateStringsSection(msgId);
}

/** One distinct value a field took, with how many samples carried it. */
interface FieldValueCount {
  value: string;
  count: number;
}

/** One grouped device/entry: the samples sharing an identity, and each
 *  field's distinct values (first-seen order) across that device's samples —
 *  so a field with >1 value here is one that changed over the flight. */
interface DeviceEntry {
  /** Total publications across this device's records. */
  count: number;
  /** Field name -> distinct values (first-seen order), one per string field. */
  fields: Map<string, FieldValueCount[]>;
}

/** The topic's device-identity fields (e.g. device_id + serial_number), in
 *  field order — records get grouped by the *combination* of their values.
 *  A composite is essential because no single field is reliably unique: a
 *  DroneCAN `device_id` collides (0/1/2 reused across ESCs, GPS, ADS-B),
 *  while a multi-sensor module shares one serial across differing device_ids.
 *  Together they pin down one logical device, so only a genuine same-device
 *  change (identity fixed, another field differs) merges into a transition. */
function identityFields(fieldNames: string[]): string[] {
  return fieldNames.filter((name) => IDENTITY_FIELD_NAMES.includes(name.toLowerCase()));
}

/** Distinct values of one field across a set of records, in first-seen order,
 *  each with the total number of samples that carried it. */
function distinctFieldValues(records: StringRecord[], fieldName: string): FieldValueCount[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = record.values[fieldName] ?? "";
    counts.set(value, (counts.get(value) ?? 0) + record.count);
  }
  return [...counts.entries()].map(([value, count]) => ({ value, count }));
}

/** Groups a topic's distinct records into devices by the combined value of
 *  its identity fields (so the same device's records merge and a changed
 *  field stays within it), or one device per record when there's no
 *  identity to group on. Ordered by publication count, most-published first. */
function buildDevices(data: TopicStrings, idFields: string[]): DeviceEntry[] {
  const groups = new Map<string, StringRecord[]>();
  data.records.forEach((record, index) => {
    // Merge on identity only when at least one identity part is non-empty;
    // an all-blank identity can't safely merge, so key per-record instead.
    const hasIdentity = idFields.some((f) => (record.values[f] ?? "") !== "");
    const key = hasIdentity ? `id\u0000${idFields.map((f) => record.values[f] ?? "").join("\u0000")}` : `rec\u0000${index}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(key, [record]);
    }
  });

  const devices: DeviceEntry[] = [];
  for (const records of groups.values()) {
    const fields = new Map<string, FieldValueCount[]>();
    for (const name of data.fieldNames) {
      fields.set(name, distinctFieldValues(records, name));
    }
    devices.push({ count: records.reduce((sum, r) => sum + r.count, 0), fields });
  }
  devices.sort((a, b) => b.count - a.count);
  return devices;
}

/** Appends a field's value(s) into a value column. `asTransition` marks
 *  every value after the first as a change-over-time (rendered with a "→"),
 *  vs. an unordered set of distinct values in the aggregate fallback view. */
function appendFieldValues(wrap: HTMLElement, vals: FieldValueCount[], asTransition: boolean): void {
  if (vals.length === 0) {
    wrap.appendChild(el("span", "string-field-value string-empty", "(empty)"));
    return;
  }
  const multiple = vals.length > 1;
  const appendOne = ({ value, count }: FieldValueCount, isChange: boolean) => {
    const empty = value === "";
    const cls =
      "string-field-value" + (isChange ? " string-change" : "") + (empty ? " string-empty" : "");
    const v = el("span", cls, empty ? "(empty)" : value);
    if (!empty) {
      v.title = value;
      // Values are truncated to one line by default (a top_metrics process
      // command line can be hundreds of chars). Click one to expand it to its
      // full, wrapped text — click again to collapse. Guarded so drag-
      // selecting the text (to copy it) doesn't also toggle the expansion.
      v.classList.add("string-clickable");
      v.addEventListener("click", () => {
        if ((window.getSelection()?.toString() ?? "") === "") {
          v.classList.toggle("string-expanded");
        }
      });
    }
    // A count only adds information when the field took more than one value;
    // a device's single-value field is already summarized by its header count.
    if (multiple) {
      v.appendChild(el("span", "string-count", ` ×${count}`));
    }
    wrap.appendChild(v);
  };
  vals.slice(0, MAX_SHOWN_STRING_VALUES).forEach((entry, i) => appendOne(entry, asTransition && i > 0));
  const hidden = vals.slice(MAX_SHOWN_STRING_VALUES);
  if (hidden.length > 0) {
    const more = el("button", "string-more", `+${hidden.length} more`);
    more.addEventListener("click", () => {
      more.remove();
      hidden.forEach((entry) => appendOne(entry, asTransition));
    });
    wrap.appendChild(more);
  }
}

/** A "field-name  value(s)" row. */
function makeStringFieldRow(name: string, vals: FieldValueCount[], asTransition: boolean): HTMLElement {
  const row = el("div", "string-field");
  const nameEl = el("span", "string-field-name", name);
  nameEl.title = name;
  row.appendChild(nameEl);
  const wrap = el("div", "string-field-values");
  appendFieldValues(wrap, vals, asTransition);
  row.appendChild(wrap);
  return row;
}

/** Device-grouped view: one block per enumerated device/entry, each listing
 *  its fields; a field that changed across the device's publications shows
 *  its values as a transition. */
function renderRecordView(section: HTMLElement, data: TopicStrings, idFields: string[], shown: Set<string>): void {
  const devices = buildDevices(data, idFields);
  const renderDevice = (device: DeviceEntry, index: number, before?: HTMLElement) => {
    const block = el("div", "string-record");
    const header = el("div", "string-record-header");
    header.appendChild(el("span", "string-record-index", String(index + 1)));
    header.appendChild(el("span", "string-count", `(×${device.count})`));
    block.appendChild(header);
    for (const name of data.fieldNames) {
      if (shown.has(name)) {
        block.appendChild(makeStringFieldRow(name, device.fields.get(name) ?? [], true));
      }
    }
    if (before) {
      section.insertBefore(block, before);
    } else {
      section.appendChild(block);
    }
  };

  devices.slice(0, MAX_SHOWN_STRING_VALUES).forEach((device, i) => renderDevice(device, i));
  const hidden = devices.slice(MAX_SHOWN_STRING_VALUES);
  if (hidden.length > 0) {
    const more = el("button", "string-more", `+${hidden.length} more device${hidden.length > 1 ? "s" : ""}`);
    more.addEventListener("click", () => {
      hidden.forEach((device, i) => renderDevice(device, MAX_SHOWN_STRING_VALUES + i, more));
      more.remove();
    });
    section.appendChild(more);
  }
}

/** Aggregate fallback view: each field's distinct values across all samples,
 *  most-frequent first — for free-form/high-cardinality text topics that
 *  aren't a device enumeration. */
function renderPerFieldView(section: HTMLElement, data: TopicStrings, shown: Set<string>): void {
  const grid = el("div", "string-grid");
  for (const name of data.fieldNames) {
    if (!shown.has(name)) {
      continue;
    }
    const vals = distinctFieldValues(data.records, name)
      .filter((v) => v.value.length > 0)
      .sort((a, b) => b.count - a.count);
    grid.appendChild(makeStringFieldRow(name, vals, false));
  }
  section.appendChild(grid);
}

/** (Re)renders the read-only string-field rows into a topic's strings
 *  subsection — from the cache if loaded, a "Reading…" placeholder while a
 *  fetch is in flight, or an error note if it failed. */
function renderStringsInto(section: HTMLElement, topic: TopicInfo, errorMessage?: string): void {
  section.textContent = "";
  const names = matchingStringFieldNames(topic);
  if (names.length === 0) {
    return;
  }
  section.appendChild(el("div", "string-divider", "strings"));

  if (errorMessage) {
    section.appendChild(el("div", "string-note", `Couldn't read values: ${errorMessage}`));
    return;
  }
  const data = state.stringsCache.get(topic.msgId);
  if (!data) {
    section.appendChild(el("div", "string-note", state.pendingStrings.has(topic.msgId) ? "Reading…" : "…"));
    return;
  }

  // Which field rows to show, from the fetched field set (which includes the
  // numeric device_id/device_type siblings, not just the char fields the
  // sidebar filter knows about) — filtered by the same name search.
  const filter = state.topicFilter.trim();
  const shown = new Set(
    filter === "" || matchesSearchTerms(topic.name, filter)
      ? data.fieldNames
      : data.fieldNames.filter((n) => matchesSearchTerms(n, filter)),
  );
  const idFields = identityFields(data.fieldNames);
  // Device view when the topic looks like an enumeration: it either has an
  // identity field, or few enough distinct records to be one device apiece.
  // A single-field or high-cardinality text topic isn't, so fall back.
  const useRecordView = data.fieldNames.length >= 2 && (idFields.length > 0 || data.records.length <= MAX_RECORD_VIEW);
  if (useRecordView) {
    renderRecordView(section, data, idFields, shown);
  } else {
    renderPerFieldView(section, data, shown);
  }

  if (data.truncated) {
    section.appendChild(
      el(
        "div",
        "string-note",
        `Showing first ${data.records.length} distinct records of ${data.sampleCount.toLocaleString()} samples.`,
      ),
    );
  }
}

/** Finds a live strings subsection by msgId and re-renders it — used when an
 *  async `strings`/`stringsError` reply lands after the list was built. */
function populateStringsSection(msgId: number, errorMessage?: string): void {
  const section = topicListEl.querySelector<HTMLElement>(`.string-field-list[data-strings-msgid="${msgId}"]`);
  const topic = state.summary?.topics.find((t) => t.msgId === msgId);
  if (section && topic) {
    renderStringsInto(section, topic, errorMessage);
  }
}

function renderTopicList(): void {
  const summary = state.summary;
  if (!summary) {
    return;
  }
  topicListEl.textContent = "";
  const filter = state.topicFilter.trim();

  for (const topic of summary.topics) {
    const topicMatches = matchesSearchTerms(topic.name, filter);
    const matchingFields =
      filter === "" || topicMatches
        ? topic.fields
        : topic.fields.filter((f) => matchesSearchTerms(f.name, filter));
    const matchingStrings = matchingStringFieldNames(topic);
    if (filter !== "" && !topicMatches && matchingFields.length === 0 && matchingStrings.length === 0) {
      continue;
    }

    const details = el("details");
    details.open = filter !== "" ? !topicMatches : state.expandedTopics.has(topic.msgId);
    const summaryEl = el("summary");
    summaryEl.appendChild(el("span", undefined, topic.name));
    summaryEl.appendChild(el("span", "topic-count", `(${topic.count})`));
    details.appendChild(summaryEl);
    details.addEventListener("toggle", () => {
      if (state.topicFilter.trim() === "") {
        if (details.open) {
          state.expandedTopics.add(topic.msgId);
        } else {
          state.expandedTopics.delete(topic.msgId);
        }
      }
      if (details.open && topic.stringFields.length > 0) {
        ensureStringsFetched(topic.msgId);
      }
    });

    const makeFieldButton = (field: FieldInfo, label: string): HTMLElement => {
      const button = el("button", "field-btn");
      button.dataset.msgId = String(topic.msgId);
      button.dataset.field = field.name;
      button.appendChild(el("span", undefined, label));
      button.appendChild(el("span", "field-type", field.type));
      button.addEventListener("click", () => toggleField(topic, field.name));
      return button;
    };

    // Struct-array instance fields (`esc[0].esc_rpm`, see plottableFields in
    // ulogData.ts) fold into one collapsible group per instance; everything
    // else renders as a flat button like before. Groups keep the position of
    // their first field so the sidebar order still mirrors the definition.
    const fieldList = el("div", "field-list");
    const instanceGroups = new Map<string, FieldInfo[]>();
    const renderOrder: (FieldInfo | string)[] = [];
    for (const field of matchingFields) {
      const instancePrefix = /^(.+\[\d+\])\./.exec(field.name)?.[1];
      if (instancePrefix != undefined) {
        let group = instanceGroups.get(instancePrefix);
        if (!group) {
          group = [];
          instanceGroups.set(instancePrefix, group);
          renderOrder.push(instancePrefix);
        }
        group.push(field);
      } else {
        renderOrder.push(field);
      }
    }
    for (const entry of renderOrder) {
      if (typeof entry !== "string") {
        fieldList.appendChild(makeFieldButton(entry, entry.name));
        continue;
      }
      const group = instanceGroups.get(entry) ?? [];
      const groupKey = `${topic.msgId}:${entry}`;
      const groupDetails = el("details", "field-group");
      // A filter that matched these fields should show them, not hide them
      // behind a closed drop-down — mirrors the topic-level rule above.
      groupDetails.open = filter !== "" && !topicMatches ? true : state.expandedFieldGroups.has(groupKey);
      const groupSummary = el("summary");
      groupSummary.appendChild(el("span", undefined, entry));
      groupSummary.appendChild(el("span", "topic-count", `(${group.length})`));
      groupDetails.appendChild(groupSummary);
      groupDetails.addEventListener("toggle", () => {
        if (state.topicFilter.trim() === "") {
          if (groupDetails.open) {
            state.expandedFieldGroups.add(groupKey);
          } else {
            state.expandedFieldGroups.delete(groupKey);
          }
        }
      });
      const groupList = el("div", "field-list");
      for (const field of group) {
        groupList.appendChild(makeFieldButton(field, field.name.slice(entry.length + 1)));
      }
      groupDetails.appendChild(groupList);
      fieldList.appendChild(groupDetails);
    }
    if (matchingFields.length === 0 && matchingStrings.length === 0) {
      fieldList.appendChild(el("div", "field-type", "no plottable fields"));
    }
    details.appendChild(fieldList);

    let stringsSection: HTMLElement | undefined;
    if (matchingStrings.length > 0) {
      stringsSection = el("div", "string-field-list");
      stringsSection.dataset.stringsMsgid = String(topic.msgId);
      details.appendChild(stringsSection);
    }

    topicListEl.appendChild(details);

    if (stringsSection) {
      renderStringsInto(stringsSection, topic);
      if (details.open) {
        ensureStringsFetched(topic.msgId);
      }
    }
  }
  refreshFieldButtons();
}

/* ---------------------------------------------------------------------- */
/* Tab panes                                                               */
/* ---------------------------------------------------------------------- */

function makeFilterBox(
  placeholder: string,
  onInput: (value: string) => void,
): { box: HTMLElement; input: HTMLInputElement } {
  const box = el("div", "filter-box");
  const input = el("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(input.value));
  box.appendChild(input);
  return { box, input };
}

/**
 * Hides a table's rows whose visible text doesn't match `filter` (see
 * matchesSearchTerms) and re-stripes the survivors by *visible* position:
 * hidden rows stay in the DOM, so a zebra table's CSS nth-child striping
 * would drift out of sync with what's shown (same reasoning as the Messages
 * pane's manual .zebra-row toggling). `forceShow` keeps every row visible —
 * for a section whose *heading* matched the filter. Returns the visible-row
 * count so callers can hide a section that filtered down to nothing.
 */
function filterTableRows(tbody: HTMLElement, filter: string, forceShow = false): number {
  const table = tbody.closest("table");
  if (table?.classList.contains("zebra-table")) {
    table.classList.add("zebra-manual");
  }
  let visibleCount = 0;
  for (const row of Array.from(tbody.children) as HTMLElement[]) {
    const show = forceShow || matchesSearchTerms(row.textContent ?? "", filter);
    row.style.display = show ? "" : "none";
    if (show) {
      row.classList.toggle("zebra-row", visibleCount % 2 === 1);
      visibleCount++;
    }
  }
  return visibleCount;
}

/**
 * Click any row to highlight it (click again to clear) — just a reading
 * aid, no other effect. Uses event delegation on the tbody so it keeps
 * working across re-renders (e.g. after a filter changes which rows exist).
 */
function enableRowSelection(tbody: HTMLElement): void {
  tbody.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest("tr");
    if (!row || row.parentElement !== tbody) {
      return;
    }
    if (row.classList.contains("row-selected")) {
      row.classList.remove("row-selected");
      return;
    }
    tbody.querySelector(".row-selected")?.classList.remove("row-selected");
    row.classList.add("row-selected");
  });
}

// Clicking anywhere that isn't the currently-selected row (a different pane,
// a toolbar button, blank space) clears it — this listener runs on the same
// bubbling click, after whichever `enableRowSelection` tbody handler above
// has already selected/deselected its own row, so it only ever clears a
// selection the click didn't just make.
document.addEventListener("click", (ev) => {
  if ((ev.target as HTMLElement).closest("tr.row-selected")) {
    return;
  }
  document.querySelectorAll("tr.row-selected").forEach((row) => row.classList.remove("row-selected"));
});

const COLUMN_MIN_WIDTH = 50;

/**
 * A table with draggable column-width handles on every column except the
 * last (which fills remaining space). `columnWidths` gives the initial
 * width in px for each of those resizable columns.
 */
function makeResizableTable(
  headers: string[],
  columnWidths: number[],
  opts?: { zebra?: boolean },
): { table: HTMLTableElement; tbody: HTMLElement } {
  const table = el("table", opts?.zebra ? "data resizable-columns zebra-table" : "data resizable-columns");
  const colgroup = el("colgroup");
  const cols = headers.map((_, i) => {
    const col = el("col");
    if (i < columnWidths.length) {
      col.style.width = `${columnWidths[i]}px`;
    }
    colgroup.appendChild(col);
    return col;
  });
  table.appendChild(colgroup);

  const thead = el("thead");
  const headRow = el("tr");
  headers.forEach((header, i) => {
    const th = el("th", undefined, header);
    if (i < headers.length - 1) {
      const resizer = el("div", "col-resizer");
      th.appendChild(resizer);
      setupColumnResizer(resizer, cols[i]!, th);
    }
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el("tbody");
  table.appendChild(tbody);
  return { table, tbody };
}

function setupColumnResizer(resizer: HTMLElement, col: HTMLElement, th: HTMLElement): void {
  let startX = 0;
  let startWidth = 0;
  const onMove = (ev: MouseEvent) => {
    const width = Math.max(COLUMN_MIN_WIDTH, startWidth + (ev.clientX - startX));
    col.style.width = `${width}px`;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing-column");
    resizer.classList.remove("active");
  };
  resizer.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    startX = ev.clientX;
    startWidth = th.getBoundingClientRect().width;
    document.body.classList.add("resizing-column");
    resizer.classList.add("active");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** A row of mutually-exclusive buttons, e.g. for the time-unit picker. */
/**
 * `disabled` options stay grayed out and inert but keep native mouse/hover
 * handling (not the `disabled` attribute) — Chromium suppresses hover
 * events, and so the `title` tooltip, on genuinely disabled buttons, which
 * would defeat the entire point of a disabled option that explains itself
 * on hover.
 */
function makeSegmented<T extends string>(
  options: { value: T; label: string; disabled?: boolean; title?: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLElement {
  const group = el("div", "segmented");
  for (const { value, label, disabled, title } of options) {
    const button = el("button", undefined, label);
    button.classList.toggle("active", value === current);
    button.classList.toggle("disabled", disabled ?? false);
    if (title) {
      button.title = title;
    }
    button.addEventListener("click", () => {
      if (disabled) {
        return;
      }
      for (const b of group.querySelectorAll("button")) {
        b.classList.remove("active");
      }
      button.classList.add("active");
      onChange(value);
    });
    group.appendChild(button);
  }
  return group;
}

/** Icon-only toggle button (pressed/unpressed), with a tooltip since it has no text label. */
function makeIconToggleButton(
  icon: string,
  title: string,
  pressed: boolean,
  onChange: (value: boolean) => void,
): HTMLElement {
  const button = el("button", "toggle-btn icon-btn");
  button.innerHTML = icon;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.classList.toggle("active", pressed);
  button.setAttribute("aria-pressed", String(pressed));
  button.addEventListener("click", () => {
    const next = !button.classList.contains("active");
    button.classList.toggle("active", next);
    button.setAttribute("aria-pressed", String(next));
    onChange(next);
  });
  return button;
}

/** Icon-only action button (not a toggle), e.g. "auto-range". */
function makeIconButton(icon: string, title: string, onClick: () => void): HTMLElement {
  const button = el("button", "icon-btn");
  button.innerHTML = icon;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", onClick);
  return button;
}

/* ---------------------------------------------------------------------- */
/* Context menu                                                            */
/* ---------------------------------------------------------------------- */

let contextMenuEl: HTMLElement | undefined;

function hideContextMenu(): void {
  contextMenuEl?.remove();
  contextMenuEl = undefined;
  document.removeEventListener("mousedown", dismissContextMenuOnOutsideClick, true);
  document.removeEventListener("keydown", dismissContextMenuOnEscape, true);
}

function dismissContextMenuOnOutsideClick(ev: MouseEvent): void {
  if (contextMenuEl && !contextMenuEl.contains(ev.target as Node)) {
    hideContextMenu();
  }
}

function dismissContextMenuOnEscape(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    hideContextMenu();
  }
}

function showContextMenu(x: number, y: number, items: { label: string; onClick: () => void }[]): void {
  hideContextMenu();
  const menu = el("div", "context-menu");
  for (const item of items) {
    const button = el("button", "context-menu-item", item.label);
    button.addEventListener("click", () => {
      hideContextMenu();
      item.onClick();
    });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  contextMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  // Capture phase so this fires before any click handler on whatever was clicked.
  document.addEventListener("mousedown", dismissContextMenuOnOutsideClick, true);
  document.addEventListener("keydown", dismissContextMenuOnEscape, true);
}

/**
 * Composites uPlot's own canvas (which already contains grid, axes, tick
 * labels and series data — it draws everything via ctx.fillText/strokes,
 * not separate DOM text) with a manually-drawn legend strip, since the live
 * legend is a separate DOM table we'd rather not try to rasterize.
 */
async function copyPlotAsImage(panel: PlotPanel): Promise<void> {
  const chart = panel.chart;
  if (!chart) {
    setPlotStatus("Nothing to copy — add a field to this plot first.");
    return;
  }
  const sourceCanvas = chart.ctx.canvas;
  const dpr = sourceCanvas.width / chart.width || 1;
  const legendRowCss = 22;
  const legendPadCss = 12;
  const legendHeightCss = panel.series.length > 0 ? legendPadCss * 2 + panel.series.length * legendRowCss : 0;

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = sourceCanvas.width;
  exportCanvas.height = sourceCanvas.height + Math.round(legendHeightCss * dpr);
  const ctx = exportCanvas.getContext("2d");
  if (!ctx) {
    setPlotStatus("Couldn't render this plot to an image.");
    return;
  }

  ctx.fillStyle = resolveColor("var(--vscode-editor-background)");
  ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
  ctx.drawImage(sourceCanvas, 0, 0);

  if (panel.series.length > 0) {
    const fontFamily = getComputedStyle(document.body).fontFamily || "sans-serif";
    ctx.font = `${13 * dpr}px ${fontFamily}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = resolveColor("var(--vscode-foreground)");
    let y = sourceCanvas.height + (legendPadCss + legendRowCss / 2) * dpr;
    for (const s of panel.series) {
      const dotRadius = 5 * dpr;
      const dotX = legendPadCss * dpr + dotRadius;
      ctx.fillStyle = seriesColor(s.slot);
      ctx.beginPath();
      ctx.arc(dotX, y, dotRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = resolveColor("var(--vscode-foreground)");
      ctx.fillText(s.label, dotX + dotRadius + 8 * dpr, y);
      y += legendRowCss * dpr;
    }
  }

  exportCanvas.toBlob(async (blob) => {
    if (!blob) {
      setPlotStatus("Couldn't render this plot to an image.");
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setPlotStatus("Plot copied to clipboard as an image.");
    } catch {
      setPlotStatus("Couldn't copy the image — this VS Code/OS combination may not support it from a webview.");
    }
  }, "image/png");
}

function setupSidebarResizer(resizer: HTMLElement, sidebar: HTMLElement): void {
  const onMove = (ev: MouseEvent) => {
    const rect = sidebar.parentElement!.getBoundingClientRect();
    const width = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, ev.clientX - rect.left));
    sidebar.style.width = `${width}px`;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("resizing-sidebar");
  };
  resizer.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    document.body.classList.add("resizing-sidebar");
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/* ---------------------------------------------------------------------- */
/* Replay tab (2D top-down flight path, from vehicle_local_position)      */
/* ---------------------------------------------------------------------- */

/** Local (x, y) bounding box, or undefined if there's no finite data at all. */
function computeBoundingBox(
  xs: Float64Array,
  ys: Float64Array,
): { minX: number; maxX: number; minY: number; maxY: number } | undefined {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return Number.isFinite(minX) && Number.isFinite(minY) ? { minX, maxX, minY, maxY } : undefined;
}

/** North maps to "up" and East to "right" on screen — the usual map/nav
 *  convention — fit uniformly (same scale on both axes, so the path isn't
 *  stretched) into the canvas with some padding, centered on the data's
 *  own bounding box. Returns undefined if there's no finite x/y data at
 *  all to fit a transform to. */
function computeReplayTransform(
  xs: Float64Array,
  ys: Float64Array,
  canvasW: number,
  canvasH: number,
  padding: number,
): { toScreen: (x: number, y: number) => [number, number]; scale: number } | undefined {
  const bbox = computeBoundingBox(xs, ys);
  if (!bbox) {
    return undefined;
  }
  const { minX, maxX, minY, maxY } = bbox;
  // North (x) spans the canvas's vertical extent, East (y) the horizontal.
  const dataSpanNorth = Math.max(1e-6, maxX - minX);
  const dataSpanEast = Math.max(1e-6, maxY - minY);
  const availW = Math.max(1, canvasW - padding * 2);
  const availH = Math.max(1, canvasH - padding * 2);
  const scale = Math.min(availW / dataSpanEast, availH / dataSpanNorth);
  const centerNorth = (minX + maxX) / 2;
  const centerEast = (minY + maxY) / 2;
  const toScreen = (x: number, y: number): [number, number] => [
    canvasW / 2 + (y - centerEast) * scale,
    canvasH / 2 - (x - centerNorth) * scale,
  ];
  return { toScreen, scale };
}

/** A simple forward-pointing triangle, rotated by `heading` (PX4 convention:
 *  radians, 0 = north, increasing clockwise) — matches how canvas's own
 *  ctx.rotate() sweeps for a positive angle when y grows downward, so no
 *  sign flip is needed between the two conventions. */
function drawVehicleIcon(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  heading: number | undefined,
  size: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(screenX, screenY);
  if (heading != undefined && Number.isFinite(heading)) {
    ctx.rotate(heading);
  }
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.6, size * 0.7);
  ctx.lineTo(0, size * 0.35);
  ctx.lineTo(-size * 0.6, size * 0.7);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** Artificial-horizon / attitude indicator — the standard cockpit instrument
 *  for roll & pitch. A sky/ground disc banks by −roll and slides vertically
 *  with pitch behind a *fixed* aircraft symbol, so the vehicle's orientation
 *  reads exactly as a pilot's would: horizon tilts and drops as the airframe
 *  banks and pitches up. Fixed bank-scale ticks around the top with a moving
 *  pointer on the disc show bank angle; a pitch ladder gives magnitude.
 *  `rollRad`/`pitchRad` are radians (PX4 sign: +roll = right bank, +pitch =
 *  nose up); non-finite values render level. Redrawn each frame into its own
 *  small canvas, sized to its CSS box (independent of the map canvas). */
const ATTITUDE_SKY = "#4a90d9";
const ATTITUDE_GROUND = "#9c6b3f";
const ATTITUDE_SYMBOL = "#ffcf33";

function drawAttitudeIndicator(canvas: HTMLCanvasElement, rollRad: number, pitchRad: number): void {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (size <= 0) {
    return;
  }
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 1;
  const roll = Number.isFinite(rollRad) ? rollRad : 0;
  const pitch = Number.isFinite(pitchRad) ? pitchRad : 0;
  const rad2deg = 180 / Math.PI;
  // ~±55° of pitch spans the radius — enough range without cramping the rungs.
  const pitchPxPerDeg = radius / 55;

  ctx.save();
  // Everything sky/ground/ladder is clipped to the instrument disc.
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();

  ctx.translate(cx, cy);
  ctx.rotate(-roll); // the disc banks opposite the (fixed) airframe symbol
  ctx.save();
  ctx.translate(0, pitch * rad2deg * pitchPxPerDeg); // nose-up slides horizon down

  const span = radius * 3; // large enough to cover the disc at any bank/pitch
  ctx.fillStyle = ATTITUDE_SKY;
  ctx.fillRect(-span, -span, span * 2, span);
  ctx.fillStyle = ATTITUDE_GROUND;
  ctx.fillRect(-span, 0, span * 2, span);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-span, 0);
  ctx.lineTo(span, 0);
  ctx.stroke();

  // Pitch ladder: a rung every 10°, longer+labeled every 20°.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.font = "8px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let deg = -40; deg <= 40; deg += 10) {
    if (deg === 0) {
      continue;
    }
    const y = -deg * pitchPxPerDeg; // +deg (nose up) rung sits above center
    const halfWidth = deg % 20 === 0 ? radius * 0.32 : radius * 0.16;
    ctx.beginPath();
    ctx.moveTo(-halfWidth, y);
    ctx.lineTo(halfWidth, y);
    ctx.stroke();
    if (deg % 20 === 0) {
      const label = String(Math.abs(deg));
      ctx.fillText(label, -halfWidth - 7, y);
      ctx.fillText(label, halfWidth + 7, y);
    }
  }
  ctx.restore(); // undo pitch slide, still banked by -roll

  // Bank scale on the rotating disc (0, ±10, ±20, ±30, ±45, ±60): banks with
  // the horizon, so whichever tick sits under the fixed top index is the
  // current bank angle — the traditional attitude-indicator arrangement.
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 1;
  for (const deg of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const angle = -Math.PI / 2 + (deg * Math.PI) / 180;
    const tickLen = deg % 30 === 0 ? 7 : 4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    ctx.lineTo(Math.cos(angle) * (radius - tickLen), Math.sin(angle) * (radius - tickLen));
    ctx.stroke();
  }
  ctx.restore(); // undo bank rotation — back to the fixed screen frame

  // Fixed top index (the bank reference the rotating scale reads against).
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx, cy - radius + 8);
  ctx.lineTo(cx - 4, cy - radius + 1);
  ctx.lineTo(cx + 4, cy - radius + 1);
  ctx.closePath();
  ctx.fill();

  // Fixed aircraft symbol: two wing stubs and a center dot.
  ctx.strokeStyle = ATTITUDE_SYMBOL;
  ctx.fillStyle = ATTITUDE_SYMBOL;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - radius * 0.5, cy);
  ctx.lineTo(cx - radius * 0.16, cy);
  ctx.moveTo(cx - radius * 0.16, cy);
  ctx.lineTo(cx - radius * 0.16, cy + radius * 0.1);
  ctx.moveTo(cx + radius * 0.16, cy);
  ctx.lineTo(cx + radius * 0.5, cy);
  ctx.moveTo(cx + radius * 0.16, cy);
  ctx.lineTo(cx + radius * 0.16, cy + radius * 0.1);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  ctx.fill();

  // Outer ring, in the theme foreground so it frames cleanly on either theme.
  ctx.strokeStyle = resolveColor("var(--vscode-foreground)");
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ---- GPS map background (OpenStreetMap raster tiles) --------------------
 * Only drawn when the log's GPS is both present and trustworthy (at least
 * one sensor_gps/vehicle_gps_position sample with fix_type >= 3, a 3D fix
 * or better — the same bar this extension already uses for GPS-derived UTC
 * time, see paramScan.ts) *and* vehicle_local_position carries a usable
 * global reference (ref_lat/ref_lon plus xy_global) to anchor a flat-earth
 * local(x,y)->(lat,lon) approximation on — the same approximation PX4
 * itself uses internally. Falls back to the plain local-position view
 * otherwise; no partial/broken map state is possible. */

const EARTH_RADIUS_M = 6378137; // WGS84 equatorial radius.
const TILE_SIZE_PX = 256;
const MIN_MAP_ZOOM = 0;
const MAX_MAP_ZOOM = 18;
/** OSM's tile usage policy asks heavier users to self-host or use a
 *  commercial provider instead — fine for this extension's actual load (a
 *  handful of tiles per flight, fetched once and cached forever), but worth
 *  revisiting if this ever needs a dedicated/paid tile source instead. */
const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

function osmTileUrl(zoom: number, tx: number, ty: number): string {
  return `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
}

function lonToWorldPx(lonDeg: number, zoom: number): number {
  return ((lonDeg + 180) / 360) * TILE_SIZE_PX * 2 ** zoom;
}

function latToWorldPx(latDeg: number, zoom: number): number {
  const latRad = (latDeg * Math.PI) / 180;
  const y = 0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
  return y * TILE_SIZE_PX * 2 ** zoom;
}

interface GpsAnchor {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

/** Anchors a flat-earth approximation on one matched (x, y, lat, lon)
 *  sample — accurate enough for a single flight's extent. */
function makeLocalToLatLon(anchor: GpsAnchor): (x: number, y: number) => [number, number] {
  const anchorLatRad = (anchor.lat * Math.PI) / 180;
  const metersPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const metersPerDegLon = metersPerDegLat * Math.cos(anchorLatRad);
  return (x: number, y: number): [number, number] => [
    anchor.lat + (x - anchor.x) / metersPerDegLat,
    anchor.lon + (y - anchor.y) / metersPerDegLon,
  ];
}

/** First vehicle_local_position sample with a valid global reference —
 *  ref_lat/ref_lon rarely (if ever) change mid-flight, so one anchor point
 *  is enough for the whole flight. Excludes exact (0, 0) (the classic
 *  "no fix yet" placeholder) and latitudes near Mercator's own ±85.05°
 *  breakdown point. */
function findGpsAnchor(
  xs: Float64Array,
  ys: Float64Array,
  refLat: Float64Array,
  refLon: Float64Array,
  xyGlobal: Float64Array,
): GpsAnchor | undefined {
  for (let i = 0; i < xs.length; i++) {
    const lat = refLat[i]!;
    const lon = refLon[i]!;
    if (
      xyGlobal[i] === 1 &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      (lat !== 0 || lon !== 0) &&
      Math.abs(lat) <= 85
    ) {
      return { x: xs[i]!, y: ys[i]!, lat, lon };
    }
  }
  return undefined;
}

/** At least one sample with a 3D fix or better (PX4/MAVLink's fix_type
 *  convention: 0 no fix .. 2 2D fix, 3 3D fix, higher for augmented fixes). */
function gpsFixTrustworthy(fixTypes: Float64Array): boolean {
  for (let i = 0; i < fixTypes.length; i++) {
    if (fixTypes[i]! >= 3) {
      return true;
    }
  }
  return false;
}

interface MapTransform {
  zoom: number;
  centerWorldPxX: number;
  centerWorldPxY: number;
  worldPxToScreen: (worldPxX: number, worldPxY: number) => [number, number];
  toScreen: (latDeg: number, lonDeg: number) => [number, number];
}

/** Picks the largest integer zoom whose lat/lon bounding box still fits the
 *  canvas (the standard slippy-map "fit bounds" algorithm), then a
 *  pure-translation (scale exactly 1) screen transform centered on that box
 *  — tiles always draw at their native 256px with no per-tile scaling or
 *  resampling. */
function computeMapTransform(
  minLat: number,
  maxLat: number,
  minLon: number,
  maxLon: number,
  canvasW: number,
  canvasH: number,
  padding: number,
): MapTransform {
  const availW = Math.max(1, canvasW - padding * 2);
  const availH = Math.max(1, canvasH - padding * 2);
  const lonSpanZ0 = Math.max(1e-9, lonToWorldPx(maxLon, 0) - lonToWorldPx(minLon, 0));
  // Mercator y grows southward, so the smaller (northern) latitude has the
  // larger world-px y — the span is the other way round from longitude's.
  const latSpanZ0 = Math.max(1e-9, latToWorldPx(minLat, 0) - latToWorldPx(maxLat, 0));
  const zoom = Math.max(
    MIN_MAP_ZOOM,
    Math.min(MAX_MAP_ZOOM, Math.floor(Math.min(Math.log2(availW / lonSpanZ0), Math.log2(availH / latSpanZ0)))),
  );
  const centerWorldPxX = lonToWorldPx((minLon + maxLon) / 2, zoom);
  const centerWorldPxY = latToWorldPx((minLat + maxLat) / 2, zoom);
  const worldPxToScreen = (wx: number, wy: number): [number, number] => [
    canvasW / 2 + (wx - centerWorldPxX),
    canvasH / 2 + (wy - centerWorldPxY),
  ];
  const toScreen = (latDeg: number, lonDeg: number): [number, number] =>
    worldPxToScreen(lonToWorldPx(lonDeg, zoom), latToWorldPx(latDeg, zoom));
  return { zoom, centerWorldPxX, centerWorldPxY, worldPxToScreen, toScreen };
}

/** Module-level (survives pane rebuilds) — a flight's bounding box only
 *  ever needs a handful of tiles regardless of zoom (the fit-bounds
 *  algorithm always sizes the box to ~fill the canvas), so this stays
 *  small. Never retries a tile that failed to load. */
const tileImageCache = new Map<string, HTMLImageElement | "error">();

function getTile(zoom: number, tx: number, ty: number, onArrive: () => void): HTMLImageElement | undefined {
  const key = `${zoom}/${tx}/${ty}`;
  const cached = tileImageCache.get(key);
  if (cached === "error") {
    return undefined;
  }
  if (cached) {
    return cached;
  }
  const img = new Image();
  img.onload = onArrive;
  img.onerror = () => tileImageCache.set(key, "error");
  img.src = osmTileUrl(zoom, tx, ty);
  tileImageCache.set(key, img);
  return img;
}

/* ---- Playback clock ----------------------------------------------------- */

const REPLAY_SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8, 16];

/** Largest index with times[index] <= targetTimeSec (times is ascending). */
function findIndexAtOrBefore(times: Float64Array, targetTimeSec: number): number {
  const last = times.length - 1;
  if (last <= 0 || targetTimeSec <= times[0]!) {
    return 0;
  }
  if (targetTimeSec >= times[last]!) {
    return last;
  }
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= targetTimeSec) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** GPS-derived series needed for the map background, all from
 *  vehicle_local_position except fixTypes (from the GPS topic itself, at
 *  its own sample rate/count — only ever used in aggregate, never indexed
 *  alongside the others). Undefined (not fetched at all here) means the log
 *  doesn't have the required fields — distinct from "has them but isn't
 *  trustworthy", which renderReplayScene below decides. */
interface ReplayGpsData {
  refLat: Float64Array;
  refLon: Float64Array;
  xyGlobal: Float64Array;
  fixTypes: Float64Array;
}

/** A field fetched on its own timeline, distinct from xs/ys/times — armed,
 *  landed, mode, airspeed, and the two secondary altitude sources all come
 *  from other topics logged at their own rates, so reading "the value as of
 *  the currently-scrubbed instant" needs findIndexAtOrBefore against this
 *  series' own `times`, not the replay's main one. */
type TimeSeries = { times: Float64Array; values: Float64Array };

/** Tries each message name in order, preferring multiId 0 within whichever
 *  name is found first — the same fallback shape every individual topic
 *  lookup in this file already used (sensor_gps/vehicle_gps_position,
 *  etc), pulled out once now that there are enough of them to matter. */
function findTopic(summary: LogSummary, ...messageNames: string[]): TopicInfo | undefined {
  for (const name of messageNames) {
    const found =
      summary.topics.find((t) => t.messageName === name && t.multiId === 0) ??
      summary.topics.find((t) => t.messageName === name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** Optional single-field fetch for a HUD element that isn't essential to
 *  the replay itself: undefined if the topic or field don't exist at all,
 *  undefined (via catch) if the fetch fails — either way the caller just
 *  omits that one element rather than breaking the whole pane. */
function fetchOptionalSeries(topic: TopicInfo | undefined, field: string): Promise<TimeSeries | undefined> {
  if (!topic || !topic.fields.some((f) => f.name === field)) {
    return Promise.resolve(undefined);
  }
  return fetchSeriesAdHoc(topic.msgId, field).catch(() => undefined);
}

/** Roll/pitch (radians) precomputed from vehicle_attitude's quaternion, on
 *  that topic's own timeline — drives the artificial-horizon instrument. Yaw
 *  is deliberately excluded: it's the compass's job, already fed by
 *  vehicle_local_position.heading (the two agree to the decimal — the derived
 *  yaw from this same quaternion was checked against heading on real logs). */
interface ReplayAttitude {
  times: Float64Array;
  roll: Float64Array;
  pitch: Float64Array;
}

/** Fetches vehicle_attitude's quaternion (q[0..3], PX4 order [w, x, y, z],
 *  body-FRD→earth-NED) and reduces it to roll/pitch arrays via the standard
 *  aerospace ZYX conversion. All four components share one timeline (same
 *  message), so they're read together and folded once here rather than per
 *  frame. Optional like the other HUD extras: undefined if the topic/fields
 *  are absent or the fetch fails. */
function fetchAttitude(topic: TopicInfo | undefined): Promise<ReplayAttitude | undefined> {
  const components = ["q[0]", "q[1]", "q[2]", "q[3]"];
  if (!topic || !components.every((c) => topic.fields.some((f) => f.name === c))) {
    return Promise.resolve(undefined);
  }
  return Promise.all(components.map((c) => fetchSeriesAdHoc(topic.msgId, c)))
    .then(([q0, q1, q2, q3]) => {
      const times = q0!.times;
      const n = times.length;
      const roll = new Float64Array(n);
      const pitch = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const w = q0!.values[i]!;
        const x = q1!.values[i]!;
        const y = q2!.values[i]!;
        const z = q3!.values[i]!;
        roll[i] = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
        pitch[i] = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
      }
      return { times, roll, pitch };
    })
    .catch(() => undefined);
}

/** PX4's vehicle_status.msg NAVIGATION_STATE_* enum, current firmware as of
 *  this writing — cross-checked against a real log's actual transitions
 *  (POSCTL -> AUTO_TAKEOFF -> AUTO_LOITER -> AUTO_RTL -> AUTO_LOITER, a
 *  plausible mission shape). Older/newer firmware or reserved slots fall
 *  back to "Mode N" rather than guessing a label that might be wrong. */
const NAV_STATE_NAMES: Record<number, string> = {
  0: "MANUAL",
  1: "ALTCTL",
  2: "POSCTL",
  3: "AUTO_MISSION",
  4: "AUTO_LOITER",
  5: "AUTO_RTL",
  8: "ACRO",
  12: "OFFBOARD",
  13: "STAB",
  17: "AUTO_TAKEOFF",
  18: "AUTO_LAND",
  19: "AUTO_FOLLOW_TARGET",
  20: "AUTO_PRECLAND",
  21: "ORBIT",
  22: "AUTO_VTOL_TAKEOFF",
};

function navStateLabel(value: number): string {
  return NAV_STATE_NAMES[value] ?? `Mode ${value}`;
}

/** Last sample where the local-frame home position was actually valid —
 *  home_position updates rarely (often just once or twice a flight), so
 *  the most recent valid one is simply the current answer. */
function lastValidHome(
  xs: Float64Array,
  ys: Float64Array,
  validLpos: Float64Array,
): { x: number; y: number } | undefined {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (validLpos[i] === 1 && Number.isFinite(xs[i]!) && Number.isFinite(ys[i]!)) {
      return { x: xs[i]!, y: ys[i]! };
    }
  }
  return undefined;
}

/** position_setpoint_triplet.current changes every time the active nav
 *  target changes — collapsing consecutive/repeated (lat, lon) pairs into
 *  a static list gives a reasonable approximation of "the waypoints this
 *  flight visited" without needing a separate mission-plan source (PX4
 *  doesn't log the full mission item list into the .ulog itself). A small
 *  epsilon merges re-derivations of the same physical point (e.g. RTL
 *  heading back to a home position computed with tiny float differences
 *  from its first appearance) instead of treating them as a new waypoint. */
interface ReplayWaypoint {
  lat: number;
  lon: number;
  /** current.acceptance_radius at the moment this waypoint was current, in
   *  meters — NOT the same thing as reading NAV_ACC_RAD's own logged value
   *  directly (see the long comment on ReplayWaypoint's fetch site for
   *  why). Undefined if the log doesn't have the field at all. */
  acceptanceRadiusM: number | undefined;
}

function dedupeWaypoints(
  lat: Float64Array,
  lon: Float64Array,
  valid: Float64Array,
  acceptanceRadius: Float64Array | undefined,
): ReplayWaypoint[] {
  const EPS_DEG = 1e-5; // ~1m
  const waypoints: ReplayWaypoint[] = [];
  for (let i = 0; i < lat.length; i++) {
    const latVal = lat[i]!;
    const lonVal = lon[i]!;
    if (valid[i] !== 1 || !Number.isFinite(latVal) || !Number.isFinite(lonVal)) {
      continue;
    }
    const isDuplicate = waypoints.some(
      (w) => Math.abs(w.lat - latVal) < EPS_DEG && Math.abs(w.lon - lonVal) < EPS_DEG,
    );
    if (!isDuplicate) {
      const radius = acceptanceRadius?.[i];
      waypoints.push({ lat: latVal, lon: lonVal, acceptanceRadiusM: radius != undefined && Number.isFinite(radius) && radius > 0 ? radius : undefined });
    }
  }
  return waypoints;
}

/** A small always-visible marker (home, a waypoint) — distinct from
 *  drawVehicleIcon, which is the single scrub-following "you are here"
 *  triangle. Text is outlined (dark stroke behind a light fill) so the
 *  label stays legible over both map tiles and the plain dark canvas. */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  shape: "diamond" | "circle",
  size: number,
  color: string,
  label?: string,
  /** Which stacked label position to use (see the placement below) — 0 is the
   *  default single-label slot; coincident markers pass 1, 2, … so their
   *  labels step apart instead of printing on top of each other. */
  labelSlot = 0,
): void {
  ctx.beginPath();
  if (shape === "diamond") {
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, size, 0, Math.PI * 2);
  }
  ctx.fillStyle = color;
  ctx.fill();
  if (label) {
    // Centered just above the marker rather than to its right: a right-side
    // label sat directly on the planned/traversed path segments that run
    // through the waypoint, whereas floating it above the marker keeps it
    // clear of them (the marker point itself is where the paths cross). The
    // dark halo keeps it legible over the map wherever it lands.
    //
    // Slot 0 sits above the marker; slot 1 below; each further pair steps out
    // by another line — so stacked labels for markers sharing a point (Home
    // and a waypoint 1 on top of it, say) all stay visible.
    const above = labelSlot % 2 === 0;
    const gap = size + 3 + Math.floor(labelSlot / 2) * 13;
    const labelY = above ? y - gap : y + gap;
    ctx.save();
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = above ? "bottom" : "top";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(label, x, labelY);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, x, labelY);
    ctx.restore();
  }
}

/** Renders the static ground track plus a scrubbable "current position"
 *  marker once x/y (and optionally heading) have actually arrived — kept
 *  separate from buildReplayPane so the pane itself can return immediately
 *  with a loading state while the fetch is still in flight. */
interface ReplaySceneData {
  times: Float64Array;
  xs: Float64Array;
  ys: Float64Array;
  headings: Float64Array | undefined;
  /** vehicle_local_position.z, NED down-positive — relative altitude is
   *  its negation. */
  altitudesDown: Float64Array | undefined;
  /** vehicle_local_position.ref_alt — MSL altitude is refAlt - altitudesDown. */
  refAlt: Float64Array | undefined;
  distBottom: Float64Array | undefined;
  distBottomValid: Float64Array | undefined;
  armed: TimeSeries | undefined;
  landed: TimeSeries | undefined;
  airspeed: TimeSeries | undefined;
  navState: TimeSeries | undefined;
  baroAlt: TimeSeries | undefined;
  gpsAlt: TimeSeries | undefined;
  home: { x: number; y: number } | undefined;
  waypoints: ReplayWaypoint[];
  gpsData: ReplayGpsData | undefined;
  attitude: ReplayAttitude | undefined;
  /** vehicle_local_position velocity (NED, m/s) — same timeline as xs/ys, so
   *  indexed directly. Ground speed is hypot(vx, vy); climb rate is -vz. */
  vx: Float64Array | undefined;
  vy: Float64Array | undefined;
  vz: Float64Array | undefined;
  /** battery_status readings (own timeline). remaining is a 0..1 fraction. */
  batteryRemaining: TimeSeries | undefined;
  batteryVoltage: TimeSeries | undefined;
  batteryCurrent: TimeSeries | undefined;
}

function renderReplayScene(pane: HTMLElement, data: ReplaySceneData): void {
  const {
    times,
    xs,
    ys,
    headings,
    altitudesDown,
    refAlt,
    distBottom,
    distBottomValid,
    armed,
    landed,
    airspeed,
    navState,
    baroAlt,
    gpsAlt,
    home,
    waypoints,
    gpsData,
    attitude,
    vx,
    vy,
    vz,
    batteryRemaining,
    batteryVoltage,
    batteryCurrent,
  } = data;

  if (times.length === 0) {
    pane.appendChild(el("div", "centered-note", "vehicle_local_position has no data points in this log."));
    return;
  }

  const gpsAnchor =
    gpsData && gpsFixTrustworthy(gpsData.fixTypes)
      ? findGpsAnchor(xs, ys, gpsData.refLat, gpsData.refLon, gpsData.xyGlobal)
      : undefined;
  const localToLatLon = gpsAnchor ? makeLocalToLatLon(gpsAnchor) : undefined;
  const mapModeActive = localToLatLon != undefined;

  // First sample where the vehicle is armed, mapped onto this pane's own
  // (local-position) timeline — armed's own times/values are a different
  // topic/rate, same zero-order-hold lookup as the HUD fields use, just
  // run once here rather than per frame.
  const armIndex = (() => {
    if (!armed) {
      return undefined;
    }
    for (let i = 0; i < armed.values.length; i++) {
      if (armed.values[i] === 1) {
        return findIndexAtOrBefore(times, armed.times[i]!);
      }
    }
    return undefined;
  })();

  const toolbar = el("div", "pane-toolbar replay-toolbar");
  const playBtn = el("button", undefined, "▶ Play") as HTMLButtonElement;
  const stopBtn = el("button", undefined, "⏹ Stop") as HTMLButtonElement;
  toolbar.appendChild(playBtn);
  toolbar.appendChild(stopBtn);
  toolbar.appendChild(el("span", undefined, "Speed:"));
  const speedSelect = el("select", "replay-speed-select") as HTMLSelectElement;
  for (const speed of REPLAY_SPEED_OPTIONS) {
    const option = el("option", undefined, `${speed}x`) as HTMLOptionElement;
    option.value = String(speed);
    option.selected = speed === 1;
    speedSelect.appendChild(option);
  }
  toolbar.appendChild(speedSelect);
  const slider = el("input", "replay-slider") as HTMLInputElement;
  slider.type = "range";
  slider.min = "0";
  slider.max = String(times.length - 1);
  slider.step = "1";
  slider.value = "0";
  if (armIndex != undefined) {
    const armTrimBtn = el("button", undefined, "Skip Pre-Arm") as HTMLButtonElement;
    armTrimBtn.title = "Trim the slider to start at the moment the vehicle armed";
    let armTrimmed = false;
    armTrimBtn.addEventListener("click", () => {
      armTrimmed = !armTrimmed;
      armTrimBtn.classList.toggle("active", armTrimmed);
      // Read the position *before* moving slider.min: setting min above the
      // current value makes the browser re-clamp slider.value immediately,
      // so a later `slider.value < armIndex` test would wrongly read false.
      // Trimming on snaps up to the arm point (but keeps a later position the
      // user already scrubbed to); trimming off leaves the position as-is.
      // Always calling updateDisplay refreshes the time/clock labels and the
      // canvas — the old code skipped that whenever the value was clamped,
      // which left the labels stale until the next manual slider nudge.
      const currentIndex = Number(slider.value);
      slider.min = armTrimmed ? String(armIndex) : "0";
      updateDisplay(armTrimmed ? Math.max(currentIndex, armIndex) : currentIndex);
    });
    toolbar.appendChild(armTrimBtn);
  }
  toolbar.appendChild(slider);
  const timeLabel = el("span", "replay-time-label", formatTimeTick(times[0]!, 1));
  toolbar.appendChild(timeLabel);

  // Wall-clock (GPS-UTC-derived) time of the current frame — shown only when
  // this log has a UTC reference, with the same user-selectable timezone as
  // the Data and Messages tabs (shared state.timezone, so a zone picked in
  // any of them applies everywhere). A clock glyph marks it as a real
  // time-of-day, distinct from the elapsed-time label beside it.
  let clockValueEl: HTMLElement | undefined;
  if (state.summary?.utcOffsetUsec != undefined) {
    const clockLabel = el("span", "replay-clock-label");
    clockLabel.title = "Wall-clock time of the current frame (from this log's GPS), in the timezone at right";
    const clockIcon = el("span", "replay-clock-icon");
    clockIcon.innerHTML = ICON_CLOCK;
    clockLabel.appendChild(clockIcon);
    clockValueEl = el("span", "replay-clock-value", formatWallClock(times[0]!, 1));
    clockLabel.appendChild(clockValueEl);
    toolbar.appendChild(clockLabel);
    const tzField = el("label", "timezone-field");
    tzField.title = "Timezone for the replay clock — shared with the Data and Messages tabs";
    tzField.appendChild(el("span", "timezone-field-label", "TZ:"));
    const tzSelect = el("select", "timezone-select") as HTMLSelectElement;
    for (const tz of listTimeZones()) {
      const option = el("option", undefined, tz) as HTMLOptionElement;
      option.value = tz;
      tzSelect.appendChild(option);
    }
    tzSelect.value = state.timezone;
    tzSelect.addEventListener("change", () => {
      state.timezone = tzSelect.value;
      updateDisplay(Number(slider.value));
    });
    tzField.appendChild(tzSelect);
    toolbar.appendChild(tzField);
  }

  toolbar.appendChild(el("span", undefined, "scroll to zoom · drag to pan · double-click to reset"));
  pane.appendChild(toolbar);

  const canvasWrap = el("div", "replay-canvas-wrap");
  const canvas = el("canvas", "replay-canvas") as HTMLCanvasElement;
  canvasWrap.appendChild(canvas);
  const attribution = el("div", "map-attribution", OSM_ATTRIBUTION);
  attribution.style.display = mapModeActive ? "" : "none";
  canvasWrap.appendChild(attribution);

  // Small HUD-style overlay for telemetry that isn't itself a position —
  // each row/chip only appears if this log actually has the data for it.
  const armedChip = el("span", "badge replay-armed-badge", "DISARMED");
  const landedChip = el("span", "badge replay-landed-badge", "ON GROUND");
  const modeChip = el("span", "badge replay-mode-badge");

  // A small aligned label/value grid reads much better than one long joined
  // string, and only the value cell's text changes per frame. Each metric
  // group (altitudes, speeds, battery) is its own such grid so the columns
  // align within a group; a row is added only if the log has that source.
  const makeKvGrid = () => {
    const grid = el("div", "replay-alt-grid");
    const add = (label: string): HTMLElement => {
      grid.appendChild(el("span", "replay-alt-key", label));
      const valueEl = el("span", "replay-alt-val", "—");
      grid.appendChild(valueEl);
      return valueEl;
    };
    return { grid, add };
  };

  const alt = makeKvGrid();
  const relValueEl = altitudesDown ? alt.add("Rel") : undefined;
  const mslValueEl = altitudesDown && refAlt ? alt.add("MSL") : undefined;
  const gpsAltValueEl = gpsAlt ? alt.add("GPS") : undefined;
  const aglValueEl = distBottom && distBottomValid ? alt.add("AGL") : undefined;
  const baroValueEl = baroAlt ? alt.add("Baro") : undefined;

  // Ground speed (horizontal, works even without an airspeed sensor) and
  // climb rate (vertical) — both derived from the local-position velocity.
  const speed = makeKvGrid();
  const groundSpeedValueEl = vx && vy ? speed.add("GS") : undefined;
  const climbValueEl = vz ? speed.add("Climb") : undefined;

  // Battery — remaining %, pack voltage, and current draw, whichever exist.
  const batt = makeKvGrid();
  const batteryRemainingEl = batteryRemaining ? batt.add("Batt") : undefined;
  const batteryVoltageEl = batteryVoltage ? batt.add("Volt") : undefined;
  const batteryCurrentEl = batteryCurrent ? batt.add("Curr") : undefined;

  // Airspeed gets its own larger, bolder readout rather than blending into
  // the small print — the one number here that's often safety-relevant.
  const airspeedValueEl = el("span", "replay-airspeed-value", "—");

  // Each kind of information gets its own small titled card, stacked in the
  // top-left corner — vehicle state, altitude, speed and power read as
  // separate things at a glance instead of merging into one dense block.
  const hudLeft = el("div", "replay-hud-left");
  const addCard = (title: string | undefined, children: HTMLElement[]): void => {
    if (children.length === 0) {
      return;
    }
    const card = el("div", "replay-card");
    if (title) {
      card.appendChild(el("div", "replay-card-title", title));
    }
    for (const child of children) {
      card.appendChild(child);
    }
    hudLeft.appendChild(card);
  };

  // Vehicle state — the chips are self-labeling, so this card has no title.
  const stateRow = el("div", "replay-status-row");
  if (armed) {
    stateRow.appendChild(armedChip);
  }
  if (landed) {
    stateRow.appendChild(landedChip);
  }
  if (navState) {
    stateRow.appendChild(modeChip);
  }
  addCard(undefined, stateRow.children.length > 0 ? [stateRow] : []);

  addCard("Altitude", alt.grid.children.length > 0 ? [alt.grid] : []);

  const speedChildren: HTMLElement[] = [];
  if (speed.grid.children.length > 0) {
    speedChildren.push(speed.grid);
  }
  if (airspeed) {
    const airspeedRow = el("div", "replay-status-row replay-airspeed-row");
    airspeedRow.appendChild(el("span", "replay-airspeed-key", "Airspeed"));
    airspeedRow.appendChild(airspeedValueEl);
    airspeedRow.appendChild(el("span", "replay-airspeed-unit", "m/s"));
    speedChildren.push(airspeedRow);
  }
  addCard("Speed", speedChildren);

  addCard("Battery", batt.grid.children.length > 0 ? [batt.grid] : []);

  if (hudLeft.children.length > 0) {
    canvasWrap.appendChild(hudLeft);
  }

  // Sleek/minimal compass — opposite corner from the status HUD. Only
  // heading is needed, so it works the same in local and map mode.
  let compassNeedle: HTMLElement | undefined;
  if (headings) {
    const compass = el("div", "replay-compass");
    compass.appendChild(el("span", "replay-compass-label n", "N"));
    compass.appendChild(el("span", "replay-compass-label e", "E"));
    compass.appendChild(el("span", "replay-compass-label s", "S"));
    compass.appendChild(el("span", "replay-compass-label w", "W"));
    compassNeedle = el("div", "replay-compass-needle");
    compass.appendChild(compassNeedle);
    canvasWrap.appendChild(compass);
  }

  // Artificial horizon (roll + pitch) — bottom-left, the free corner, with a
  // compact numeric roll/pitch readout beneath it. Only present when the log
  // has vehicle_attitude; redrawn per frame alongside the map.
  let attitudeCanvas: HTMLCanvasElement | undefined;
  let rollValueEl: HTMLElement | undefined;
  let pitchValueEl: HTMLElement | undefined;
  if (attitude) {
    const attitudeBox = el("div", "replay-attitude");
    attitudeCanvas = el("canvas", "replay-attitude-canvas") as HTMLCanvasElement;
    attitudeBox.appendChild(attitudeCanvas);
    const readout = el("div", "replay-attitude-readout");
    const rollCell = el("span", "replay-attitude-cell");
    rollCell.appendChild(el("span", "replay-attitude-key", "R"));
    rollValueEl = el("span", "replay-attitude-val", "—");
    rollCell.appendChild(rollValueEl);
    const pitchCell = el("span", "replay-attitude-cell");
    pitchCell.appendChild(el("span", "replay-attitude-key", "P"));
    pitchValueEl = el("span", "replay-attitude-val", "—");
    pitchCell.appendChild(pitchValueEl);
    readout.appendChild(rollCell);
    readout.appendChild(pitchCell);
    attitudeBox.appendChild(readout);
    canvasWrap.appendChild(attitudeBox);
  }

  pane.appendChild(canvasWrap);

  const REPLAY_PADDING_PX = 32;
  const VEHICLE_ICON_PX = 10;
  const MIN_VIEW_SCALE = 0.2;
  const MAX_VIEW_SCALE = 40;

  // User pan/zoom, layered on top of the auto-fit transform below — reset
  // only by double-click, otherwise persists across scrubbing/playback/
  // resize redraws.
  let viewScale = 1;
  let viewPanX = 0;
  let viewPanY = 0;

  const draw = (index: number) => {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvasWrap.clientWidth;
    const cssHeight = canvasWrap.clientHeight;
    if (cssWidth <= 0 || cssHeight <= 0) {
      return;
    }
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Zooms/pans around the canvas center on top of whatever the auto-fit
    // transform below produced — a uniform (non-rotating) similarity
    // transform, so squares (tiles) stay square after it.
    const applyView = (bx: number, by: number): [number, number] => [
      cssWidth / 2 + (bx - cssWidth / 2) * viewScale + viewPanX,
      cssHeight / 2 + (by - cssHeight / 2) * viewScale + viewPanY,
    ];

    let baseToScreen: (x: number, y: number) => [number, number];
    // Hoisted out of the branch below (rather than block-scoped to it) so
    // waypoint markers — given directly as lat/lon, never as local x/y —
    // can still be placed after the branch without re-deriving it.
    let mapTransform: MapTransform | undefined;

    if (localToLatLon) {
      const bbox = computeBoundingBox(xs, ys);
      if (!bbox) {
        return;
      }
      const [latAtMinX, lonAtMinY] = localToLatLon(bbox.minX, bbox.minY);
      const [latAtMaxX, lonAtMaxY] = localToLatLon(bbox.maxX, bbox.maxY);
      // A local const (rather than using the hoisted `mapTransform` `let`
      // directly): narrowing doesn't survive into the closures below for a
      // reassignable binding, but does for a const one.
      const mt = computeMapTransform(latAtMinX, latAtMaxX, lonAtMinY, lonAtMaxY, cssWidth, cssHeight, REPLAY_PADDING_PX);
      mapTransform = mt;

      // Visible world-px extent at the *current* view (not just the fit-
      // bounds one) — inverting applyView so zooming out with the wheel
      // actually fetches/draws the extra surrounding tiles it reveals,
      // instead of leaving them blank.
      const screenToWorldPx = (sx: number, sy: number): [number, number] => [
        mt.centerWorldPxX + (sx - cssWidth / 2 - viewPanX) / viewScale,
        mt.centerWorldPxY + (sy - cssHeight / 2 - viewPanY) / viewScale,
      ];
      const [wx0, wy0] = screenToWorldPx(0, 0);
      const [wx1, wy1] = screenToWorldPx(cssWidth, cssHeight);
      const maxTileIndex = 2 ** mt.zoom - 1;
      let minTx = Math.max(0, Math.floor(Math.min(wx0, wx1) / TILE_SIZE_PX));
      let maxTx = Math.min(maxTileIndex, Math.floor(Math.max(wx0, wx1) / TILE_SIZE_PX));
      let minTy = Math.max(0, Math.floor(Math.min(wy0, wy1) / TILE_SIZE_PX));
      let maxTy = Math.min(maxTileIndex, Math.floor(Math.max(wy0, wy1) / TILE_SIZE_PX));
      // Soft cap so zooming way out can't trigger an unbounded tile-fetch
      // storm — clamped symmetrically around the visible center.
      const MAX_TILES_PER_AXIS = 32;
      if (maxTx - minTx + 1 > MAX_TILES_PER_AXIS) {
        const centerTx = Math.round((minTx + maxTx) / 2);
        minTx = Math.max(0, centerTx - Math.floor(MAX_TILES_PER_AXIS / 2));
        maxTx = Math.min(maxTileIndex, minTx + MAX_TILES_PER_AXIS - 1);
      }
      if (maxTy - minTy + 1 > MAX_TILES_PER_AXIS) {
        const centerTy = Math.round((minTy + maxTy) / 2);
        minTy = Math.max(0, centerTy - Math.floor(MAX_TILES_PER_AXIS / 2));
        maxTy = Math.min(maxTileIndex, minTy + MAX_TILES_PER_AXIS - 1);
      }
      for (let tx = minTx; tx <= maxTx; tx++) {
        for (let ty = minTy; ty <= maxTy; ty++) {
          const img = getTile(mt.zoom, tx, ty, () => draw(Number(slider.value)));
          if (img && img.complete && img.naturalWidth > 0) {
            // Two corners transformed independently (rather than a fixed
            // 256px draw) so the tile scales with viewScale too.
            const [sx1, sy1] = applyView(...mt.worldPxToScreen(tx * TILE_SIZE_PX, ty * TILE_SIZE_PX));
            const [sx2, sy2] = applyView(...mt.worldPxToScreen((tx + 1) * TILE_SIZE_PX, (ty + 1) * TILE_SIZE_PX));
            ctx.drawImage(img, sx1, sy1, sx2 - sx1, sy2 - sy1);
          }
        }
      }

      baseToScreen = (x, y) => {
        const [lat, lon] = localToLatLon(x, y);
        return mt.toScreen(lat, lon);
      };
    } else {
      const transform = computeReplayTransform(xs, ys, cssWidth, cssHeight, REPLAY_PADDING_PX);
      if (!transform) {
        return;
      }
      baseToScreen = transform.toScreen;
    }

    const toScreen = (x: number, y: number): [number, number] => applyView(...baseToScreen(x, y));

    // Flight path: the remaining (not-yet-reached) segment first in the
    // usual accent color, then the already-traversed segment redrawn on
    // top in a second, clearly different color, so playback progress reads
    // at a glance.
    const clampedIndex = Math.max(0, Math.min(xs.length - 1, index));
    const strokePathSegment = (endIndex: number, color: string) => {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= endIndex; i++) {
        if (!Number.isFinite(xs[i]!) || !Number.isFinite(ys[i]!)) {
          continue;
        }
        const [sx, sy] = toScreen(xs[i]!, ys[i]!);
        if (!started) {
          ctx.moveTo(sx, sy);
          started = true;
        } else {
          ctx.lineTo(sx, sy);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    strokePathSegment(xs.length - 1, resolveColor("var(--ulog-series-1)"));
    strokePathSegment(clampedIndex, resolveColor("var(--ulog-series-6)"));

    // Static markers — home, and (map mode only, since position_setpoint
    // has no local-frame equivalent to fall back to) waypoints — drawn
    // under the vehicle icon but over the path.
    //
    // Markers that land on (nearly) the same screen point — most commonly a
    // mission whose waypoint 1 sits right on Home — would otherwise print
    // their labels on top of each other. Hand each label the next free stack
    // slot for its cluster so they step apart (first above, next below, …).
    const placedLabels: { x: number; y: number; slot: number }[] = [];
    const nextLabelSlot = (x: number, y: number): number => {
      let maxSlot = -1;
      for (const placed of placedLabels) {
        if (Math.hypot(placed.x - x, placed.y - y) < 14) {
          maxSlot = Math.max(maxSlot, placed.slot);
        }
      }
      const slot = maxSlot + 1;
      placedLabels.push({ x, y, slot });
      return slot;
    };

    if (home) {
      const [hx, hy] = toScreen(home.x, home.y);
      drawMarker(ctx, hx, hy, "diamond", 6, resolveColor("var(--ulog-series-4)"), "Home", nextLabelSlot(hx, hy));
    }
    const mt = mapTransform;
    if (mt) {
      const waypointColor = resolveColor("var(--ulog-series-7)");
      waypoints.forEach((wp, i) => {
        const [wx, wy] = applyView(...mt.toScreen(wp.lat, wp.lon));
        if (wp.acceptanceRadiusM != undefined) {
          // Radius in screen px derived the same way the marker's own
          // position is (through mt.toScreen + applyView), rather than a
          // separate meters-per-pixel formula — automatically correct
          // under whatever zoom/pan is active right now.
          const metersPerDegLon = (Math.PI / 180) * EARTH_RADIUS_M * Math.cos((wp.lat * Math.PI) / 180);
          const lonOffset = wp.acceptanceRadiusM / metersPerDegLon;
          const [ex, ey] = applyView(...mt.toScreen(wp.lat, wp.lon + lonOffset));
          const radiusPx = Math.hypot(ex - wx, ey - wy);
          ctx.beginPath();
          ctx.arc(wx, wy, radiusPx, 0, Math.PI * 2);
          ctx.strokeStyle = waypointColor;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        drawMarker(ctx, wx, wy, "circle", 5, waypointColor, String(i + 1), nextLabelSlot(wx, wy));
      });
    }

    // Current position — a third, even more distinct color so it doesn't
    // blend into the traversed trail right behind it.
    if (Number.isFinite(xs[clampedIndex]!) && Number.isFinite(ys[clampedIndex]!)) {
      const [screenX, screenY] = toScreen(xs[clampedIndex]!, ys[clampedIndex]!);
      const heading = headings?.[clampedIndex];
      drawVehicleIcon(ctx, screenX, screenY, heading, VEHICLE_ICON_PX, resolveColor("var(--ulog-series-8)"));
    }

    // HUD text — armed/landed/mode/airspeed and two of the altitude
    // sources come from different topics/timelines than xs/ys, so look up
    // whatever value was most recently in effect at the current sample's
    // own time (zero-order hold), same technique the playback clock uses
    // to map elapsed time back to an index.
    const atOrBefore = (series: TimeSeries): number => series.values[findIndexAtOrBefore(series.times, times[clampedIndex]!)]!;

    if (relValueEl && altitudesDown) {
      const v = altitudesDown[clampedIndex]!;
      relValueEl.textContent = Number.isFinite(v) ? `${(-v).toFixed(1)} m` : "—";
    }
    if (mslValueEl && altitudesDown && refAlt) {
      const rel = altitudesDown[clampedIndex]!;
      const ref = refAlt[clampedIndex]!;
      mslValueEl.textContent = Number.isFinite(rel) && Number.isFinite(ref) ? `${(ref - rel).toFixed(1)} m` : "—";
    }
    if (gpsAltValueEl && gpsAlt) {
      const v = atOrBefore(gpsAlt);
      gpsAltValueEl.textContent = Number.isFinite(v) ? `${v.toFixed(1)} m` : "—";
    }
    if (aglValueEl && distBottom && distBottomValid) {
      const valid = distBottomValid[clampedIndex] === 1;
      const v = distBottom[clampedIndex]!;
      aglValueEl.textContent = valid && Number.isFinite(v) ? `${v.toFixed(1)} m` : "—";
    }
    if (baroValueEl && baroAlt) {
      const v = atOrBefore(baroAlt);
      baroValueEl.textContent = Number.isFinite(v) ? `${v.toFixed(1)} m` : "—";
    }

    if (groundSpeedValueEl && vx && vy) {
      const gs = Math.hypot(vx[clampedIndex]!, vy[clampedIndex]!);
      groundSpeedValueEl.textContent = Number.isFinite(gs) ? `${gs.toFixed(1)} m/s` : "—";
    }
    if (climbValueEl && vz) {
      const climb = -vz[clampedIndex]!; // NED down-positive → up-positive climb
      climbValueEl.textContent = Number.isFinite(climb) ? `${climb >= 0 ? "+" : ""}${climb.toFixed(1)} m/s` : "—";
    }

    if (batteryRemainingEl && batteryRemaining) {
      const v = atOrBefore(batteryRemaining);
      batteryRemainingEl.textContent = Number.isFinite(v) ? `${Math.round(v * 100)} %` : "—";
    }
    if (batteryVoltageEl && batteryVoltage) {
      const v = atOrBefore(batteryVoltage);
      batteryVoltageEl.textContent = Number.isFinite(v) ? `${v.toFixed(1)} V` : "—";
    }
    if (batteryCurrentEl && batteryCurrent) {
      const v = atOrBefore(batteryCurrent);
      batteryCurrentEl.textContent = Number.isFinite(v) ? `${v.toFixed(1)} A` : "—";
    }

    if (airspeed) {
      const v = atOrBefore(airspeed);
      airspeedValueEl.textContent = Number.isFinite(v) ? v.toFixed(1) : "—";
    }

    if (compassNeedle && headings) {
      const heading = headings[clampedIndex];
      if (Number.isFinite(heading)) {
        compassNeedle.style.transform = `translate(-50%, -100%) rotate(${(heading! * 180) / Math.PI}deg)`;
      }
    }

    if (attitudeCanvas && attitude) {
      const ai = findIndexAtOrBefore(attitude.times, times[clampedIndex]!);
      const roll = attitude.roll[ai]!;
      const pitch = attitude.pitch[ai]!;
      drawAttitudeIndicator(attitudeCanvas, roll, pitch);
      const fmtDeg = (rad: number): string => {
        if (!Number.isFinite(rad)) {
          return "—";
        }
        const deg = Math.round((rad * 180) / Math.PI);
        return `${deg > 0 ? "+" : ""}${deg}°`;
      };
      if (rollValueEl) {
        rollValueEl.textContent = fmtDeg(roll);
      }
      if (pitchValueEl) {
        pitchValueEl.textContent = fmtDeg(pitch);
      }
    }

    if (navState) {
      const v = atOrBefore(navState);
      if (Number.isFinite(v)) {
        modeChip.textContent = navStateLabel(v);
      }
    }

    if (armed) {
      const isArmed = atOrBefore(armed) === 1;
      armedChip.textContent = isArmed ? "ARMED" : "DISARMED";
      armedChip.classList.toggle("armed", isArmed);
    }
    if (landed) {
      const isLanded = atOrBefore(landed) === 1;
      landedChip.textContent = isLanded ? "ON GROUND" : "IN AIR";
      landedChip.classList.toggle("in-air", !isLanded);
    }
  };

  // Scroll to zoom (around the cursor), drag to pan, double-click to reset
  // — the usual map/graphics-viewer convention, matching the tile layer
  // this view can now show.
  canvasWrap.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const rect = canvasWrap.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const cx = canvasWrap.clientWidth / 2;
      const cy = canvasWrap.clientHeight / 2;
      const newScale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, viewScale * Math.pow(1.0015, -event.deltaY)));
      const actualFactor = newScale / viewScale;
      viewPanX = mx - cx - (mx - cx - viewPanX) * actualFactor;
      viewPanY = my - cy - (my - cy - viewPanY) * actualFactor;
      viewScale = newScale;
      draw(Number(slider.value));
    },
    { passive: false },
  );

  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;
  const onPanMove = (event: MouseEvent) => {
    viewPanX = panOriginX + (event.clientX - panStartX);
    viewPanY = panOriginY + (event.clientY - panStartY);
    draw(Number(slider.value));
  };
  const onPanEnd = () => {
    canvasWrap.style.cursor = "";
    document.removeEventListener("mousemove", onPanMove);
    document.removeEventListener("mouseup", onPanEnd);
  };
  canvasWrap.addEventListener("mousedown", (event) => {
    event.preventDefault();
    panStartX = event.clientX;
    panStartY = event.clientY;
    panOriginX = viewPanX;
    panOriginY = viewPanY;
    canvasWrap.style.cursor = "grabbing";
    document.addEventListener("mousemove", onPanMove);
    document.addEventListener("mouseup", onPanEnd);
  });
  canvasWrap.addEventListener("dblclick", () => {
    viewScale = 1;
    viewPanX = 0;
    viewPanY = 0;
    draw(Number(slider.value));
  });

  const updateDisplay = (index: number) => {
    // slider.min, not a literal 0: the "Skip Pre-Arm" trim (if on) raises
    // it above 0, and nothing should be able to scrub earlier than that.
    const clamped = Math.max(Number(slider.min), Math.min(times.length - 1, index));
    slider.value = String(clamped);
    timeLabel.textContent = formatTimeTick(times[clamped]!, 1);
    if (clockValueEl) {
      clockValueEl.textContent = formatWallClock(times[clamped]!, 1);
    }
    draw(clamped);
  };

  let isPlaying = false;
  let rafId: number | undefined;
  let anchorWallMs = 0;
  let anchorTimeSec = 0;

  const reanchor = (index: number) => {
    anchorWallMs = performance.now();
    anchorTimeSec = times[Math.max(0, Math.min(times.length - 1, index))]!;
  };

  const pausePlayback = () => {
    isPlaying = false;
    playBtn.textContent = "▶ Play";
    playBtn.classList.remove("active");
    if (rafId != undefined) {
      cancelAnimationFrame(rafId);
      rafId = undefined;
    }
  };

  const tick = () => {
    const speed = Number(speedSelect.value);
    const targetTimeSec = anchorTimeSec + ((performance.now() - anchorWallMs) / 1000) * speed;
    updateDisplay(findIndexAtOrBefore(times, targetTimeSec));
    if (targetTimeSec >= times[times.length - 1]!) {
      pausePlayback();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };

  const play = () => {
    if (isPlaying) {
      return;
    }
    isPlaying = true;
    playBtn.textContent = "⏸ Pause";
    playBtn.classList.add("active");
    const currentIndex = Number(slider.value);
    reanchor(currentIndex >= times.length - 1 ? Number(slider.min) : currentIndex);
    rafId = requestAnimationFrame(tick);
  };

  const stopPlayback = () => {
    pausePlayback();
    updateDisplay(Number(slider.min));
  };

  playBtn.addEventListener("click", () => (isPlaying ? pausePlayback() : play()));
  stopBtn.addEventListener("click", stopPlayback);

  slider.addEventListener("input", () => {
    const index = Number(slider.value);
    timeLabel.textContent = formatTimeTick(times[index]!, 1);
    if (clockValueEl) {
      clockValueEl.textContent = formatWallClock(times[index]!, 1);
    }
    draw(index);
    if (isPlaying) {
      reanchor(index);
    }
  });

  new ResizeObserver(() => draw(Number(slider.value))).observe(canvasWrap);
  draw(0);
}

function buildReplayPane(summary: LogSummary): HTMLElement {
  const pane = el("section", "tab-pane fixed-toolbar replay-pane");
  pane.dataset.tab = "replay";

  const topic = findTopic(summary, "vehicle_local_position");
  if (!topic) {
    pane.appendChild(
      el("div", "centered-note", "No vehicle_local_position data in this log — nothing to replay."),
    );
    return pane;
  }
  const hasField = (name: string) => topic.fields.some((f) => f.name === name);
  if (!hasField("x") || !hasField("y")) {
    pane.appendChild(
      el(
        "div",
        "centered-note",
        "This log's vehicle_local_position doesn't have x/y fields — nothing to replay.",
      ),
    );
    return pane;
  }
  const hasHeading = hasField("heading");
  const hasZ = hasField("z");
  const hasVelocity = hasField("vx") && hasField("vy") && hasField("vz");
  const hasRefAlt = hasField("ref_alt");
  const hasDistBottom = hasField("dist_bottom") && hasField("dist_bottom_valid");
  const hasGpsAnchorFields = hasField("ref_lat") && hasField("ref_lon") && hasField("xy_global");

  const gpsTopic = findTopic(summary, "sensor_gps", "vehicle_gps_position");
  const hasFixType = gpsTopic?.fields.some((f) => f.name === "fix_type") ?? false;
  const canAttemptMap = hasGpsAnchorFields && gpsTopic != undefined && hasFixType;

  const armedTopic = findTopic(summary, "actuator_armed");
  const landedTopic = findTopic(summary, "vehicle_land_detected");
  const airspeedTopic = findTopic(summary, "airspeed_validated", "airspeed");
  const statusTopic = findTopic(summary, "vehicle_status");
  const airDataTopic = findTopic(summary, "vehicle_air_data");
  const attitudeTopic = findTopic(summary, "vehicle_attitude");
  const batteryTopic = findTopic(summary, "battery_status");

  const homeTopic = findTopic(summary, "home_position");
  const hasHomeLocal =
    (homeTopic?.fields.some((f) => f.name === "x") ?? false) &&
    (homeTopic?.fields.some((f) => f.name === "y") ?? false) &&
    (homeTopic?.fields.some((f) => f.name === "valid_lpos") ?? false);

  // Waypoints only make sense in map mode — position_setpoint carries
  // lat/lon, not a local-frame equivalent to fall back to.
  const spTripletTopic = findTopic(summary, "position_setpoint_triplet");
  const hasWaypointFields =
    canAttemptMap &&
    (spTripletTopic?.fields.some((f) => f.name === "current.lat") ?? false) &&
    (spTripletTopic?.fields.some((f) => f.name === "current.lon") ?? false) &&
    (spTripletTopic?.fields.some((f) => f.name === "current.valid") ?? false);
  // current.acceptance_radius is the *effective* radius PX4 used for that
  // specific waypoint at the time — not necessarily the same as NAV_ACC_RAD's
  // own logged value (a mission item can override it, and NAV_ACC_RAD's
  // change history has no trustworthy timestamps to line up against
  // waypoint timing anyway — see paramScan.ts's changesByParam comment).
  // Reading it per-setpoint sidesteps that entirely and is correct even if
  // NAV_ACC_RAD changed mid-flight.
  const hasAcceptanceRadius = spTripletTopic?.fields.some((f) => f.name === "current.acceptance_radius") ?? false;

  const loadingNote = el("div", "centered-note", "Loading flight path…");
  pane.appendChild(loadingNote);

  Promise.all([
    fetchSeriesAdHoc(topic.msgId, "x"),
    fetchSeriesAdHoc(topic.msgId, "y"),
    hasHeading ? fetchSeriesAdHoc(topic.msgId, "heading") : Promise.resolve(undefined),
    hasZ ? fetchSeriesAdHoc(topic.msgId, "z") : Promise.resolve(undefined),
    hasVelocity ? fetchSeriesAdHoc(topic.msgId, "vx") : Promise.resolve(undefined),
    hasVelocity ? fetchSeriesAdHoc(topic.msgId, "vy") : Promise.resolve(undefined),
    hasVelocity ? fetchSeriesAdHoc(topic.msgId, "vz") : Promise.resolve(undefined),
    hasRefAlt ? fetchSeriesAdHoc(topic.msgId, "ref_alt") : Promise.resolve(undefined),
    hasDistBottom ? fetchSeriesAdHoc(topic.msgId, "dist_bottom") : Promise.resolve(undefined),
    hasDistBottom ? fetchSeriesAdHoc(topic.msgId, "dist_bottom_valid") : Promise.resolve(undefined),
    // Everything from here down is an optional HUD/marker enhancement —
    // any failure just means that one element doesn't show, not a broken
    // replay.
    fetchOptionalSeries(armedTopic, "armed"),
    fetchOptionalSeries(landedTopic, "landed"),
    fetchOptionalSeries(airspeedTopic, "true_airspeed_m_s"),
    fetchOptionalSeries(statusTopic, "nav_state"),
    fetchOptionalSeries(airDataTopic, "baro_alt_meter"),
    fetchOptionalSeries(gpsTopic, "altitude_msl_m"),
    fetchAttitude(attitudeTopic),
    fetchOptionalSeries(batteryTopic, "remaining"),
    fetchOptionalSeries(batteryTopic, "voltage_v"),
    fetchOptionalSeries(batteryTopic, "current_a"),
    hasHomeLocal
      ? Promise.all([
          fetchSeriesAdHoc(homeTopic!.msgId, "x"),
          fetchSeriesAdHoc(homeTopic!.msgId, "y"),
          fetchSeriesAdHoc(homeTopic!.msgId, "valid_lpos"),
        ])
          .then(([hx, hy, hvalid]) => lastValidHome(hx.values, hy.values, hvalid.values))
          .catch(() => undefined)
      : Promise.resolve(undefined),
    hasWaypointFields
      ? Promise.all([
          fetchSeriesAdHoc(spTripletTopic!.msgId, "current.lat"),
          fetchSeriesAdHoc(spTripletTopic!.msgId, "current.lon"),
          fetchSeriesAdHoc(spTripletTopic!.msgId, "current.valid"),
          hasAcceptanceRadius
            ? fetchSeriesAdHoc(spTripletTopic!.msgId, "current.acceptance_radius")
            : Promise.resolve(undefined),
        ])
          .then(([lat, lon, valid, radius]) => dedupeWaypoints(lat.values, lon.values, valid.values, radius?.values))
          .catch(() => [] as ReplayWaypoint[])
      : Promise.resolve([] as ReplayWaypoint[]),
    canAttemptMap
      ? Promise.all([
          fetchSeriesAdHoc(topic.msgId, "ref_lat"),
          fetchSeriesAdHoc(topic.msgId, "ref_lon"),
          fetchSeriesAdHoc(topic.msgId, "xy_global"),
          fetchSeriesAdHoc(gpsTopic!.msgId, "fix_type"),
        ])
          .then(
            ([refLat, refLon, xyGlobal, fixType]): ReplayGpsData => ({
              refLat: refLat.values,
              refLon: refLon.values,
              xyGlobal: xyGlobal.values,
              fixTypes: fixType.values,
            }),
          )
          // The map background is an optional enhancement — any failure
          // fetching its inputs just means no map, not a broken replay.
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ])
    .then(
      ([
        xSeries,
        ySeries,
        headingSeries,
        zSeries,
        vxSeries,
        vySeries,
        vzSeries,
        refAltSeries,
        distBottomSeries,
        distBottomValidSeries,
        armed,
        landed,
        airspeed,
        navState,
        baroAlt,
        gpsAlt,
        attitude,
        batteryRemaining,
        batteryVoltage,
        batteryCurrent,
        home,
        waypoints,
        gpsData,
      ]) => {
        loadingNote.remove();
        renderReplayScene(pane, {
          times: xSeries.times,
          xs: xSeries.values,
          ys: ySeries.values,
          headings: headingSeries?.values,
          altitudesDown: zSeries?.values,
          refAlt: refAltSeries?.values,
          distBottom: distBottomSeries?.values,
          distBottomValid: distBottomValidSeries?.values,
          armed,
          landed,
          airspeed,
          navState,
          baroAlt,
          gpsAlt,
          home,
          waypoints,
          gpsData,
          attitude,
          vx: vxSeries?.values,
          vy: vySeries?.values,
          vz: vzSeries?.values,
          batteryRemaining,
          batteryVoltage,
          batteryCurrent,
        });
      },
    )
    .catch((message: string) => {
      loadingNote.textContent = `Failed to load flight path: ${message}`;
    });

  return pane;
}

function buildPlotsPane(): HTMLElement {
  const pane = el("section", "tab-pane");
  pane.dataset.tab = "data";

  const sidebar = el("aside", "sidebar");
  const topicFilter = makeFilterBox("Filter topics and fields…", (value) => {
    state.topicFilter = value;
    renderTopicList();
  });
  sidebar.appendChild(topicFilter.box);
  topicListEl = el("div", "topic-list");
  sidebar.appendChild(topicListEl);
  pane.appendChild(sidebar);

  const resizer = el("div", "sidebar-resizer");
  resizer.title = "Drag to resize";
  pane.appendChild(resizer);
  setupSidebarResizer(resizer, sidebar);

  const sidebarToggle = el("button", "sidebar-toggle");
  sidebarToggle.innerHTML = ICON_SIDEBAR;
  sidebarToggle.appendChild(el("span", undefined, "Topics"));
  const setSidebarCollapsed = (collapsed: boolean) => {
    state.sidebarCollapsed = collapsed;
    sidebar.style.display = collapsed ? "none" : "";
    resizer.style.display = collapsed ? "none" : "";
    sidebarToggle.classList.toggle("collapsed", collapsed);
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarToggle.title = collapsed
      ? "Show the topic list"
      : "Hide the topic list to give the plots the full width";
    // The plots' flex row just changed width under them — uPlot only
    // re-measures when told to.
    resizeAllCharts();
  };
  sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!state.sidebarCollapsed));
  setSidebarCollapsed(state.sidebarCollapsed);
  searchFocusByTab.set("data", () => {
    // The topic filter lives inside the sidebar — focusing it while the
    // sidebar is hidden would silently do nothing.
    if (state.sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
    topicFilter.input.focus();
    topicFilter.input.select();
  });

  const plotPane = el("div", "plot-pane");
  const toolbar = el("div", "plot-toolbar");
  toolbar.appendChild(sidebarToggle);
  plotStatusEl = el("span");
  toolbar.appendChild(plotStatusEl);
  targetLabelEl = el("span", "target-label");
  toolbar.appendChild(targetLabelEl);
  toolbar.appendChild(el("span", "spacer"));
  toolbar.appendChild(el("span", undefined, "drag to zoom · double-click to reset"));
  const resetZoomBtn = el("button", undefined, "Reset zoom");
  resetZoomBtn.addEventListener("click", resetAllZoom);
  toolbar.appendChild(resetZoomBtn);
  const addPlotBtn = el("button", "primary", "+ Add Plot");
  addPlotBtn.addEventListener("click", () => createPanel());
  toolbar.appendChild(addPlotBtn);
  const clearButton = el("button", undefined, "Clear all");
  clearButton.addEventListener("click", clearAllPlots);
  toolbar.appendChild(clearButton);
  plotPane.appendChild(toolbar);

  const viewToolbar = el("div", "plot-toolbar view-toolbar");
  viewToolbar.appendChild(el("span", "view-toolbar-label", "Time axis:"));
  const utcAvailable = state.summary?.utcOffsetUsec != undefined;
  const timeUnitOptions: { value: TimeUnit; label: string; disabled?: boolean; title?: string }[] = [
    { value: "seconds", label: "s" },
    { value: "minutes", label: "min" },
    // Grayed out (not omitted) when the log has no GPS-derived reference to
    // convert boot-relative time into — see paramScan.ts's utcOffsetUsec —
    // so it's discoverable, with the tooltip saying why it's unavailable
    // rather than the option just silently not being there.
    {
      value: "wallclock",
      label: "Clock",
      disabled: !utcAvailable,
      title: utcAvailable
        ? "Wall-clock time, from this log's GPS"
        : (state.summary?.utcUnavailableReason ?? "No GPS UTC reference available in this log"),
    },
  ];
  const timezoneField = el("label", "timezone-field");
  timezoneField.title = "Timezone used for the Clock time axis";
  timezoneField.appendChild(el("span", "timezone-field-label", "TZ:"));
  const timezoneSelect = el("select", "timezone-select");
  for (const tz of listTimeZones()) {
    const option = el("option", undefined, tz) as HTMLOptionElement;
    option.value = tz;
    timezoneSelect.appendChild(option);
  }
  timezoneSelect.value = state.timezone;
  timezoneSelect.addEventListener("change", () => {
    state.timezone = timezoneSelect.value;
    rebuildAllCharts();
  });
  timezoneField.appendChild(timezoneSelect);
  timezoneField.style.display = state.timeUnit === "wallclock" ? "" : "none";

  viewToolbar.appendChild(
    makeSegmented(
      timeUnitOptions,
      state.timeUnit,
      (value) => {
        state.timeUnit = value;
        timezoneField.style.display = value === "wallclock" ? "" : "none";
        rebuildAllCharts();
      },
    ),
  );
  viewToolbar.appendChild(timezoneField);
  viewToolbar.appendChild(makeIconButton(ICON_MARKER, "Add a draggable time marker, shown on every plot", addMarker));
  viewToolbar.appendChild(makeIconButton(ICON_MARKER_CLEAR, "Remove all time markers", clearAllMarkers));
  viewToolbar.appendChild(
    makeIconToggleButton(
      ICON_ZERO,
      "Shift x-axis so the first timestamp is 0",
      state.zeroOffset,
      (value) => {
        state.zeroOffset = value;
        rebuildAllCharts(true);
      },
    ),
  );
  viewToolbar.appendChild(
    makeIconToggleButton(ICON_LINES, "Show lines connecting data points", state.showLines, (value) => {
      setShowLines(value);
    }),
  );
  viewToolbar.appendChild(
    makeIconToggleButton(ICON_POINTS, "Show data points", state.showPoints, (value) => {
      setShowPoints(value);
    }),
  );
  viewToolbar.appendChild(
    makeIconToggleButton(ICON_GRID, "Show background grid", state.showGrid, (value) => {
      state.showGrid = value;
      rebuildAllCharts();
    }),
  );
  viewToolbar.appendChild(
    makeIconToggleButton(ICON_STEP, "Step lines (hold value until the next sample)", state.stepped, (value) => {
      state.stepped = value;
      rebuildAllCharts();
    }),
  );

  viewToolbar.appendChild(el("span", "spacer"));
  // Tighter internal gap than the rest of the row — these all belong to
  // one visual group (pick a view / save it / manage them), not separate
  // controls that happen to share a toolbar.
  const savedViewsGroup = el("div", "saved-views-group");
  savedViewSelect = el("select", "saved-view-select") as HTMLSelectElement;
  savedViewSelect.addEventListener("change", () => {
    const chosenName = savedViewSelect.value;
    if (!chosenName) {
      // Picked the placeholder — just deselect, don't touch the plots
      // (there's nothing here that corresponds to "load nothing").
      state.lockedSavedViewName = undefined;
      refreshSavedViewSelect();
      return;
    }
    const view = state.savedViews.find((v) => v.name === chosenName);
    if (!view) {
      return;
    }
    // Switching away from a view with unsaved changes would silently
    // discard them — everything else here is a no-loss action (first load,
    // switching from an unmodified view), so only this path needs a gate.
    const previousLockedName = state.lockedSavedViewName;
    if (previousLockedName && previousLockedName !== chosenName && isLoadedViewModified()) {
      void showConfirmDialog(
        `"${previousLockedName}" has unsaved changes. Load "${chosenName}" anyway and discard them?`,
        "Discard & Load",
      ).then((discard) => {
        if (!discard) {
          savedViewSelect.value = previousLockedName;
          return;
        }
        loadSavedView(view);
        state.lockedSavedViewName = view.name;
        refreshSavedViewSelect();
      });
      return;
    }
    loadSavedView(view);
    state.lockedSavedViewName = view.name;
    refreshSavedViewSelect();
  });
  savedViewsGroup.appendChild(savedViewSelect);
  saveAreaEl = el("span", "save-view-area");
  savedViewsGroup.appendChild(saveAreaEl);
  const manageViewsBtn = el("button", undefined, "Manage Views");
  manageViewsBtn.title = "Rename or delete any saved view";
  manageViewsBtn.addEventListener("click", openManageViewsDialog);
  savedViewsGroup.appendChild(manageViewsBtn);
  viewToolbar.appendChild(savedViewsGroup);
  refreshSavedViewSelect();

  plotPane.appendChild(viewToolbar);

  const plotsScroll = el("div", "plots-scroll");
  plotsColumnEl = el("div", "plots-column");
  plotsEmptyEl = el(
    "div",
    "plots-empty",
    "Click “+ Add Plot” to create a plot, then select fields from the topic list on the left. Add more plots to compare different signals side by side — their time axes stay in sync.",
  );
  plotsScroll.appendChild(plotsColumnEl);
  plotsScroll.appendChild(plotsEmptyEl);
  plotPane.appendChild(plotsScroll);
  pane.appendChild(plotPane);

  updatePlotsEmptyState();
  return pane;
}

function buildInfoPane(summary: LogSummary): HTMLElement {
  // "General" (short, fixed content) stays outside any scroll region, and
  // the potentially-long "Log information" table gets its own isolated
  // scroll container — nothing else shares its top-of-scroll space, which
  // is what actually keeps its sticky header gap-free (see table.data's
  // border-collapse comment for the other half of that fix).
  const pane = el("section", "tab-pane fixed-toolbar");
  pane.dataset.tab = "info";

  // Ctrl+F target: one filter over both tables below, since a reader rarely
  // knows (or cares) whether the key they want landed in "General" or in
  // the log's own information entries.
  const infoFilter = makeFilterBox("Filter info…", (value) => applyInfoFilter(value));
  const toolbar = el("div", "pane-toolbar params-toolbar");
  toolbar.appendChild(infoFilter.box);
  pane.appendChild(toolbar);
  registerSearchInput("info", infoFilter.input);

  const fixedSection = el("div", "pane-fixed");
  const generalHeading = el("h3", "section", "General");
  fixedSection.appendChild(generalHeading);
  const general = makeResizableTable(["Key", "Value"], [140], { zebra: true });
  const [startSec, endSec] = summary.timeRange;
  const rows: [string, string][] = [
    ["File", summary.fileName],
    ["Size", formatFileSize(summary.fileSizeBytes)],
    ["ULog version", String(summary.ulogVersion)],
    ["Duration", formatDuration(summary.durationSec)],
    ["Time range", `${formatTimeTick(startSec, 1)} – ${formatTimeTick(endSec, 1)}`],
    ["Start time", formatUtcStartTime(summary)],
    ["Messages", summary.messageCount.toLocaleString()],
    ["Topics", String(summary.topics.length)],
    ["Parameters", String(summary.parameters.length)],
  ];
  for (const [key, value] of rows) {
    const row = el("tr");
    row.appendChild(el("td", "key", key));
    row.appendChild(el("td", undefined, value));
    general.tbody.appendChild(row);
  }
  enableRowSelection(general.tbody);
  fixedSection.appendChild(general.table);
  const infoHeading = el("h3", "section", "Log information");
  fixedSection.appendChild(infoHeading);
  pane.appendChild(fixedSection);

  const info = makeResizableTable(["Key", "Value"], [220], { zebra: true });
  for (const [key, value] of summary.info) {
    const row = el("tr");
    row.appendChild(el("td", "key", key));
    row.appendChild(el("td", undefined, value));
    info.tbody.appendChild(row);
  }
  enableRowSelection(info.tbody);
  const scrollArea = el("div", "table-scroll");
  scrollArea.appendChild(info.table);
  pane.appendChild(scrollArea);

  const applyInfoFilter = (filter: string) => {
    const generalVisible = filterTableRows(general.tbody, filter);
    generalHeading.style.display = generalVisible > 0 ? "" : "none";
    general.table.style.display = generalVisible > 0 ? "" : "none";
    const infoVisible = filterTableRows(info.tbody, filter);
    infoHeading.style.display = infoVisible > 0 ? "" : "none";
    info.table.style.display = infoVisible > 0 ? "" : "none";
  };
  return pane;
}

function isChangedFromDefault(param: ParameterInfo): boolean {
  return param.defaultValue != undefined && param.value !== param.defaultValue;
}

function makeStatTile(value: string, label: string, title?: string): HTMLElement {
  const tile = el("div", "stat-tile");
  if (title) {
    tile.title = title;
  }
  tile.appendChild(el("span", "stat-value", value));
  tile.appendChild(el("span", "stat-label", label));
  return tile;
}

const DEFAULT_VALUE_EXPLANATION =
  "PX4's recorded default for this build, read from this log file's own " +
  "'parameter default' entries — not an external database, so it's exact " +
  "for this flight, but only covers whichever parameters this specific " +
  "firmware build chose to log a default for (often a minority).";

function buildParametersStatsBar(summary: LogSummary): HTMLElement {
  const wrap = el("div", "pane-fixed");
  const bar = el("div", "params-stats");
  const hasDefaults = summary.parameters.some((p) => p.defaultValue != undefined);
  const withDefaults = summary.parameters.filter((p) => p.defaultValue != undefined).length;
  const changedFromDefault = summary.parameters.filter(isChangedFromDefault).length;
  const changedInFlight = summary.parameters.filter((p) => p.changes.length > 0).length;

  bar.appendChild(makeStatTile(String(summary.parameters.length), "parameters"));
  bar.appendChild(
    hasDefaults
      ? makeStatTile(String(changedFromDefault), "changed from default", DEFAULT_VALUE_EXPLANATION)
      : makeStatTile("—", "changed from default", "This log has no recorded default values"),
  );
  bar.appendChild(makeStatTile(String(changedInFlight), "changed mid-flight"));
  wrap.appendChild(bar);

  if (hasDefaults) {
    wrap.appendChild(
      el(
        "div",
        "params-hint",
        `Default values are from this log's own metadata (${withDefaults} of ${summary.parameters.length} parameters have one), not all firmware builds record them for every parameter.`,
      ),
    );
  }
  return wrap;
}

function buildParametersPane(summary: LogSummary): HTMLElement {
  const pane = el("section", "tab-pane fixed-toolbar");
  pane.dataset.tab = "parameters";

  pane.appendChild(buildParametersStatsBar(summary));

  const toolbar = el("div", "pane-toolbar params-toolbar");
  const filterInput = el("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter parameters…";
  const filterBox = el("div", "filter-box");
  filterBox.appendChild(filterInput);
  registerSearchInput("parameters", filterInput);
  toolbar.appendChild(filterBox);
  toolbar.appendChild(
    makeSegmented<ParameterQuickFilter>(
      [
        { value: "all", label: "All" },
        { value: "default", label: "Changed from default" },
        { value: "flight", label: "Changed mid-flight" },
      ],
      state.parameterQuickFilter,
      (value) => {
        state.parameterQuickFilter = value;
        render(state.parameterFilter);
      },
    ),
  );
  pane.appendChild(toolbar);

  const { table, tbody } = makeResizableTable(["Parameter", "Value", "Default", ""], [220, 100, 100]);
  table.querySelector("th:nth-child(3)")?.setAttribute("title", DEFAULT_VALUE_EXPLANATION);
  enableRowSelection(tbody);
  const render = (filter: string) => {
    tbody.textContent = "";
    let visibleIndex = 0;
    for (const param of summary.parameters) {
      if (filter.trim() !== "" && !matchesSearchTerms(param.name, filter)) {
        continue;
      }
      if (state.parameterQuickFilter === "default" && !isChangedFromDefault(param)) {
        continue;
      }
      if (state.parameterQuickFilter === "flight" && param.changes.length === 0) {
        continue;
      }
      for (const row of buildParameterRows(param, visibleIndex)) {
        tbody.appendChild(row);
      }
      visibleIndex++;
    }
  };
  filterInput.addEventListener("input", () => {
    state.parameterFilter = filterInput.value;
    render(filterInput.value);
  });

  const scrollArea = el("div", "table-scroll");
  scrollArea.appendChild(table);
  pane.appendChild(scrollArea);
  filterInput.value = state.parameterFilter;
  render(state.parameterFilter);
  return pane;
}

/** One row for a parameter, plus an optional second row with its change history. */
function buildParameterRows(param: ParameterInfo, visibleIndex: number): HTMLElement[] {
  const row = el("tr", visibleIndex % 2 === 1 ? "param-row zebra-row" : "param-row");
  row.appendChild(el("td", "key param-name", param.name));

  const changed = isChangedFromDefault(param);
  row.appendChild(el("td", changed ? "num value-changed" : "num", formatNumber(param.value)));
  row.appendChild(
    el("td", "num muted", param.defaultValue != undefined ? formatNumber(param.defaultValue) : "—"),
  );

  const flagCell = el("td", "param-flags");
  row.appendChild(flagCell);

  if (param.changes.length === 0) {
    return [row];
  }

  const changeCount = param.changes.length;
  const badge = el("button", "badge changed-param", `${changeCount} change${changeCount > 1 ? "s" : ""}`);
  badge.title = "Show change history";
  flagCell.appendChild(badge);

  // No timestamp column — see ParameterInfo.changes' own doc comment for
  // why the closest available proxy for "when" isn't trustworthy enough to
  // show. An ordinal ("#1", "#2", ...) at least conveys the order.
  const history = el("div", "param-history");
  history.style.display = "none";
  const initialRow = el("div", "param-history-row");
  initialRow.appendChild(el("span", "param-history-time", "initial"));
  initialRow.appendChild(el("span", "param-history-value num", formatNumber(param.value)));
  history.appendChild(initialRow);
  param.changes.forEach((value, index) => {
    const line = el("div", "param-history-row");
    line.appendChild(el("span", "param-history-time", `#${index + 1}`));
    line.appendChild(el("span", "param-history-value num", formatNumber(value)));
    history.appendChild(line);
  });
  badge.addEventListener("click", () => {
    history.style.display = history.style.display === "none" ? "block" : "none";
  });

  const historyCell = el("td");
  historyCell.colSpan = 4;
  historyCell.appendChild(history);
  const historyRow = el("tr", "param-history-container");
  historyRow.appendChild(historyCell);

  return [row, historyRow];
}

type MessageLevelFilter = "all" | "info" | "warn" | "err";

/** Accepts "m:ss", "h:mm:ss", or a plain number of seconds. */
function parseTimeInput(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").map(Number);
    if (parts.some((p) => !Number.isFinite(p))) {
      return undefined;
    }
    if (parts.length === 2) {
      return parts[0]! * 60 + parts[1]!;
    }
    if (parts.length === 3) {
      return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
    }
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function flashRow(row: HTMLElement): void {
  row.classList.remove("row-flash");
  // Force a reflow so re-adding the class restarts the animation even if
  // the row was already flashed a moment ago.
  void row.offsetWidth;
  row.classList.add("row-flash");
}

/**
 * Works around a real, confirmed bug in Auterion's data-logger (and the
 * PX4/ulog_cpp v1.0.1 library it vendors): their `Logging::Level` enum is
 * defined with ASCII digit character literals (`'0'`..`'7'`, i.e. 48-55)
 * instead of plain integers (0-7). PX4 flight-controller messages always
 * write the correct raw 0-7 value, but companion-computer log lines relayed
 * through data-logger (journald/kernel messages, tagged e.g. "[kernel]" or
 * "[data-logger]") get their level byte written as the ASCII code of the
 * digit instead of its numeric value — so a real "Info" (6) message shows
 * up as 54. Undo that specific off-by-48 here so both sources render with
 * the same, correct severity; if a value doesn't fit either convention
 * (0-7 or 48-55), it's genuinely unrecognized and passed through as-is.
 */
function resolveMessageLevel(rawLevel: number): number {
  if (rawLevel >= 0 && rawLevel < LEVEL_NAMES.length) {
    return rawLevel;
  }
  const asciiDecoded = rawLevel - 48;
  if (asciiDecoded >= 0 && asciiDecoded < LEVEL_NAMES.length) {
    return asciiDecoded;
  }
  return rawLevel;
}

function levelLabel(rawLevel: number): string {
  const level = resolveMessageLevel(rawLevel);
  return LEVEL_NAMES[level] ?? "UNKNOWN";
}

/** Shared between the Messages pane's per-row badge and the Structure
 *  pane's level histogram. */
function levelBadgeClass(rawLevel: number): string {
  const resolvedLevel = resolveMessageLevel(rawLevel);
  const knownLevel = resolvedLevel >= 0 && resolvedLevel < LEVEL_NAMES.length;
  if (!knownLevel) {
    return "badge";
  }
  if (resolvedLevel <= 3) {
    return "badge level-err";
  }
  if (resolvedLevel === 4) {
    return "badge level-warn";
  }
  if (resolvedLevel === 5) {
    return "badge level-notice";
  }
  if (resolvedLevel === 6) {
    return "badge level-info";
  }
  return "badge level-debug"; // resolvedLevel === 7
}

function buildMessagesPane(summary: LogSummary): HTMLElement {
  if (summary.logMessages.length === 0) {
    const pane = el("section", "tab-pane scroll");
    pane.dataset.tab = "messages";
    pane.appendChild(el("div", "centered-note", "No log messages in this file."));
    return pane;
  }

  const pane = el("section", "tab-pane fixed-toolbar");
  pane.dataset.tab = "messages";

  // Console messages (e.g. kernel boot lines) can carry garbage timestamps far
  // outside the flight — show those as "—" instead of an absurd time, and skip
  // them when jumping to a time below.
  const maxSaneTime = summary.timeRange[1] + 3600;
  const utcAvailable = summary.utcOffsetUsec != undefined;
  const { table, tbody } = makeResizableTable(["Time", "Level", "Message"], [130, 70]);
  table.classList.add("messages-table");
  enableRowSelection(tbody);
  // Date included (unlike the Data tab's Clock axis) — a bare time-of-day
  // would be ambiguous for a log that happens to span a midnight rollover.
  const formatClockCell = (timeSec: number) => `(${formatWallClockDate(timeSec)} ${formatWallClock(timeSec, 3)})`;
  const entries: { row: HTMLElement; message: LogMessageInfo }[] = [];
  for (const message of summary.logMessages) {
    const row = el("tr");
    const saneTime = message.timeSec >= 0 && message.timeSec <= maxSaneTime;
    const timeCell = el("td", "num time-cell");
    if (saneTime) {
      timeCell.appendChild(el("span", "time-cell-raw", message.timeSec.toFixed(3)));
      if (utcAvailable) {
        timeCell.appendChild(el("span", "time-cell-clock", formatClockCell(message.timeSec)));
      }
    } else {
      timeCell.textContent = "—";
    }
    row.appendChild(timeCell);
    const levelCell = el("td");
    levelCell.appendChild(el("span", levelBadgeClass(message.level), levelLabel(message.level)));
    row.appendChild(levelCell);
    row.appendChild(el("td", undefined, message.message));
    tbody.appendChild(row);
    entries.push({ row, message });
  }

  let levelFilter: MessageLevelFilter = "all";
  let textFilter = "";
  let visible: { row: HTMLElement; message: LogMessageInfo }[] = [];
  let cursor = -1;

  const passesFilters = (message: LogMessageInfo) => {
    const level = resolveMessageLevel(message.level);
    if (levelFilter === "err" && level > 3) {
      return false;
    }
    if (levelFilter === "warn" && level > 4) {
      return false;
    }
    // DEBUG (7) only ever shows under "All" — every other tier, including
    // "Info", excludes it.
    if (levelFilter === "info" && level > 6) {
      return false;
    }
    if (textFilter.trim() !== "" && !matchesSearchTerms(message.message, textFilter)) {
      return false;
    }
    return true;
  };

  const countLabel = el("span", "messages-count");
  const updateCountLabel = () => {
    countLabel.textContent =
      levelFilter === "all" && textFilter.trim() === ""
        ? `${visible.length} messages`
        : `${visible.length} of ${entries.length}`;
  };

  const applyFilters = () => {
    visible = [];
    for (const entry of entries) {
      const show = passesFilters(entry.message);
      entry.row.style.display = show ? "" : "none";
      // Hidden rows stay in the DOM (filtering toggles display, not
      // removal), so nth-child-based striping would drift out of sync with
      // what's actually visible — track parity by visible position instead.
      entry.row.classList.toggle("zebra-row", show && visible.length % 2 === 1);
      if (show) {
        visible.push(entry);
      }
    }
    cursor = -1;
    updateCountLabel();
  };

  const jumpTo = (index: number) => {
    if (index < 0 || index >= visible.length) {
      return;
    }
    cursor = index;
    const entry = visible[index]!;
    entry.row.scrollIntoView({ block: "center" });
    flashRow(entry.row);
  };

  const searchBox = el("div", "filter-box messages-search");
  const searchInput = el("input");
  searchInput.type = "text";
  searchInput.placeholder = "Search messages…";
  searchBox.appendChild(searchInput);
  registerSearchInput("messages", searchInput);
  searchInput.addEventListener("input", () => {
    textFilter = searchInput.value;
    applyFilters();
  });

  const toolbar = el("div", "pane-toolbar messages-toolbar");
  toolbar.appendChild(searchBox);
  toolbar.appendChild(
    makeSegmented<MessageLevelFilter>(
      [
        { value: "all", label: "All" },
        { value: "info", label: "Info" },
        { value: "warn", label: "Warnings" },
        { value: "err", label: "Errors" },
      ],
      levelFilter,
      (value) => {
        levelFilter = value;
        applyFilters();
      },
    ),
  );
  const clockToggleBtn = el("button", undefined, "Clock") as HTMLButtonElement;
  clockToggleBtn.classList.toggle("disabled", !utcAvailable);
  clockToggleBtn.title = utcAvailable
    ? "Show each message's wall-clock time (from this log's GPS), in the timezone below"
    : (summary.utcUnavailableReason ?? "No GPS UTC reference available in this log");
  // Same field as the Data tab's Clock time axis — same shared
  // state.timezone too, so picking a zone in either place applies to both.
  const timezoneField = el("label", "timezone-field");
  timezoneField.title = "Timezone used for the Clock column";
  timezoneField.appendChild(el("span", "timezone-field-label", "TZ:"));
  const timezoneSelect = el("select", "timezone-select");
  for (const tz of listTimeZones()) {
    const option = el("option", undefined, tz) as HTMLOptionElement;
    option.value = tz;
    timezoneSelect.appendChild(option);
  }
  timezoneSelect.value = state.timezone;
  // Fits the column to whatever's actually the widest rendered value right
  // now, rather than a hardcoded guess — scrollWidth reports a cell's full
  // (unclamped) content size even though table-layout: fixed + overflow:
  // hidden are visually clipping it to the column's current width.
  const timeCol = table.querySelector<HTMLElement>("colgroup col:first-child");
  const resizeTimeColumnToFit = () => {
    if (!timeCol) {
      return;
    }
    let maxWidth = 0;
    for (const entry of entries) {
      const cell = entry.row.querySelector<HTMLElement>(".time-cell");
      if (cell) {
        maxWidth = Math.max(maxWidth, cell.scrollWidth);
      }
    }
    if (maxWidth > 0) {
      timeCol.style.width = `${maxWidth}px`;
    }
  };
  const refreshClockCells = () => {
    for (const entry of entries) {
      const cell = entry.row.querySelector<HTMLElement>(".time-cell-clock");
      if (cell) {
        cell.textContent = formatClockCell(entry.message.timeSec);
      }
    }
    resizeTimeColumnToFit();
  };
  timezoneSelect.addEventListener("change", () => {
    state.timezone = timezoneSelect.value;
    refreshClockCells();
    // Keeps an already-open Data tab's own Clock-mode axis (if it's using
    // one) in sync too, same as changing it from that tab's own dropdown.
    rebuildAllCharts();
  });
  timezoneField.appendChild(timezoneSelect);
  timezoneField.style.display = "none";
  clockToggleBtn.addEventListener("click", () => {
    if (!utcAvailable) {
      return;
    }
    const next = !clockToggleBtn.classList.contains("active");
    clockToggleBtn.classList.toggle("active", next);
    table.classList.toggle("show-clock", next);
    timezoneField.style.display = next ? "" : "none";
    resizeTimeColumnToFit();
  });
  resizeTimeColumnToFit();
  toolbar.appendChild(countLabel);
  // The spacer's gap is what actually pushes Clock/TZ away from the level
  // filter buttons — right next to "Errors" (as this used to be laid out)
  // read as a 5th filter option instead of an unrelated display toggle.
  toolbar.appendChild(el("span", "spacer"));
  toolbar.appendChild(clockToggleBtn);
  toolbar.appendChild(timezoneField);
  toolbar.appendChild(makeIconButton(ICON_PREV, "Previous message", () => jumpTo((cursor <= 0 ? 0 : cursor - 1))));
  toolbar.appendChild(makeIconButton(ICON_NEXT, "Next message", () => jumpTo(cursor + 1)));
  toolbar.appendChild(el("span", undefined, "Jump to:"));
  const jumpInput = el("input", "time-jump-input");
  jumpInput.type = "text";
  jumpInput.placeholder = "m:ss";
  toolbar.appendChild(jumpInput);
  const jumpBtn = el("button", undefined, "Go");
  toolbar.appendChild(jumpBtn);
  pane.appendChild(toolbar);

  const doJump = () => {
    const target = parseTimeInput(jumpInput.value);
    if (target == undefined) {
      return;
    }
    let bestIdx = -1;
    let bestDiff = Infinity;
    for (let i = 0; i < visible.length; i++) {
      const t = visible[i]!.message.timeSec;
      if (t < 0 || t > maxSaneTime) {
        continue;
      }
      const diff = Math.abs(t - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }
    jumpTo(bestIdx);
  };
  jumpBtn.addEventListener("click", doJump);
  jumpInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      doJump();
    }
  });

  const scrollArea = el("div", "table-scroll");
  scrollArea.appendChild(table);
  pane.appendChild(scrollArea);

  applyFilters();
  return pane;
}

/* ---------------------------------------------------------------------- */
/* Structure tab (raw ulog layout, for debugging the log itself)          */
/* ---------------------------------------------------------------------- */

function appendKeyValueRows(tbody: HTMLElement, rows: [string, string][]): void {
  for (const [key, value] of rows) {
    const row = el("tr");
    row.appendChild(el("td", "key", key));
    row.appendChild(el("td", undefined, value));
    tbody.appendChild(row);
  }
}

function buildStructurePane(summary: LogSummary): HTMLElement {
  // The outer pane never scrolls itself — only `pane` (the inner
  // .structure-scroll div) does, and with no top padding of its own. That
  // separation (same pattern as .table-scroll elsewhere) is what keeps each
  // table's sticky header flush with the true top of the scrollport;
  // padding-then-overflow on the same element left an 8px gap above each
  // sticky header that whatever scrolled-past row happened to be there
  // would show through.
  const outerPane = el("section", "tab-pane fixed-toolbar");
  outerPane.dataset.tab = "structure";

  // Ctrl+F target: one filter across every section below. A section stays
  // visible when its heading matches (all of its rows shown) or when at
  // least one of its rows does; sections with nothing left collapse away.
  const structureFilter = makeFilterBox("Filter structure…", (value) => applyStructureFilter(value));
  const filterToolbar = el("div", "pane-toolbar params-toolbar");
  filterToolbar.appendChild(structureFilter.box);
  outerPane.appendChild(filterToolbar);
  registerSearchInput("structure", structureFilter.input);

  const pane = el("div", "structure-scroll");

  pane.appendChild(el("h3", "section", "Overview"));
  const statsBar = el("div", "params-stats");
  statsBar.appendChild(makeStatTile(String(summary.ulogVersion), "ULog version"));
  statsBar.appendChild(makeStatTile(formatFileSize(summary.headerSizeBytes), "header size"));
  statsBar.appendChild(makeStatTile(summary.messageCount.toLocaleString(), "data messages"));
  statsBar.appendChild(
    makeStatTile(
      String(summary.dropouts.length),
      "dropouts",
      summary.dropouts.length > 0
        ? "Logged gaps in the data section — see Dropouts below"
        : "No logging gaps detected in this file",
    ),
  );
  pane.appendChild(statsBar);

  pane.appendChild(el("h3", "section", "File Layout"));
  const appendedBytes =
    summary.hasAppendedDataFlag && summary.appendedDataOffset != undefined
      ? Math.max(0, summary.fileSizeBytes - summary.appendedDataOffset)
      : 0;
  const dataBytes = Math.max(0, summary.fileSizeBytes - summary.headerSizeBytes - appendedBytes);
  const layoutTable = makeResizableTable(["Section", "Size"], [160], { zebra: true });
  const layoutPct = (bytes: number) => (summary.fileSizeBytes > 0 ? ` (${((bytes / summary.fileSizeBytes) * 100).toFixed(1)}%)` : "");
  const layoutRows: [string, string][] = [
    ["Header section", `${formatFileSize(summary.headerSizeBytes)}${layoutPct(summary.headerSizeBytes)}`],
    ["Data section", `${formatFileSize(dataBytes)}${layoutPct(dataBytes)}`],
  ];
  if (summary.hasAppendedDataFlag) {
    layoutRows.push(["Appended section", `${formatFileSize(appendedBytes)}${layoutPct(appendedBytes)}`]);
  }
  layoutRows.push(["Total file size", formatFileSize(summary.fileSizeBytes)]);
  for (const [key, value] of layoutRows) {
    const row = el("tr");
    row.appendChild(el("td", "key", key));
    row.appendChild(el("td", "num", value));
    layoutTable.tbody.appendChild(row);
  }
  enableRowSelection(layoutTable.tbody);
  pane.appendChild(layoutTable.table);

  pane.appendChild(el("h3", "section", "Flags & Header"));
  const flagsTable = makeResizableTable(["Key", "Value"], [220], { zebra: true });
  const flagsRows: [string, string][] = [
    ["Default parameters recorded (compatible flag)", summary.hasDefaultParametersFlag ? "Yes" : "No"],
    ["Has appended section (incompatible flag)", summary.hasAppendedDataFlag ? "Yes" : "No"],
  ];
  if (summary.hasAppendedDataFlag && summary.appendedDataOffset != undefined) {
    flagsRows.push(["Appended section offset", `${summary.appendedDataOffset.toLocaleString()} bytes`]);
  }
  flagsRows.push([
    "File header timestamp (raw)",
    summary.fileHeaderTimestampUsec > 0 ? `${summary.fileHeaderTimestampUsec.toLocaleString()} µs` : "0 (not set by logger)",
  ]);
  appendKeyValueRows(flagsTable.tbody, flagsRows);
  enableRowSelection(flagsTable.tbody);
  pane.appendChild(flagsTable.table);

  pane.appendChild(el("h3", "section", "Message Type Counts"));
  const typeTable = makeResizableTable(["Type", "Count"], [200], { zebra: true });
  for (const { label, typeCode, count } of summary.messageTypeCounts) {
    const row = el("tr");
    row.appendChild(el("td", "key", `${label} (0x${typeCode.toString(16).padStart(2, "0")})`));
    row.appendChild(el("td", "num", count.toLocaleString()));
    typeTable.tbody.appendChild(row);
  }
  enableRowSelection(typeTable.tbody);
  pane.appendChild(typeTable.table);

  if (summary.logLevelCounts.length > 0) {
    pane.appendChild(el("h3", "section", "Log Message Levels"));
    const levelTable = makeResizableTable(["Level", "Count"], [160], { zebra: true });
    for (const { level, count } of summary.logLevelCounts) {
      const row = el("tr");
      const levelCell = el("td");
      levelCell.appendChild(el("span", levelBadgeClass(level), levelLabel(level)));
      row.appendChild(levelCell);
      row.appendChild(el("td", "num", count.toLocaleString()));
      levelTable.tbody.appendChild(row);
    }
    enableRowSelection(levelTable.tbody);
    pane.appendChild(levelTable.table);
  }

  pane.appendChild(el("h3", "section", `Format Definitions (${summary.formatDefinitions.length})`));
  const defTable = makeResizableTable(["Name", "Format"], [220], { zebra: true });
  for (const def of summary.formatDefinitions) {
    const row = el("tr");
    row.appendChild(el("td", "key", def.name));
    const formatCell = el("td", "mono", def.format);
    formatCell.title = def.format;
    row.appendChild(formatCell);
    defTable.tbody.appendChild(row);
  }
  enableRowSelection(defTable.tbody);
  pane.appendChild(defTable.table);

  pane.appendChild(el("h3", "section", `Subscriptions (${summary.topics.length})`));
  const subTable = makeResizableTable(["msgId", "Name", "Multi ID", "Data Count"], [70, 240, 80], { zebra: true });
  for (const topic of summary.topics.slice().sort((a, b) => a.msgId - b.msgId)) {
    const row = el("tr");
    row.appendChild(el("td", "num", String(topic.msgId)));
    row.appendChild(el("td", undefined, topic.messageName));
    row.appendChild(el("td", "num", String(topic.multiId)));
    row.appendChild(el("td", "num", topic.count.toLocaleString()));
    subTable.tbody.appendChild(row);
  }
  enableRowSelection(subTable.tbody);
  pane.appendChild(subTable.table);

  pane.appendChild(el("h3", "section", `Untrusted Topics (${summary.untrustedTopics.length})`));
  if (summary.untrustedTopics.length === 0) {
    pane.appendChild(
      el("div", "params-hint", "None — every subscription's timestamp field could be trusted for time-based data."),
    );
  } else {
    pane.appendChild(
      el(
        "div",
        "params-hint",
        "These subscriptions' timestamp field couldn't be resolved (no uint64_t “timestamp” field where expected) — typically non-PX4-native companion-computer topics with unusual layouts. Excluded from this scan's own time-based computations.",
      ),
    );
    const untrustedTable = makeResizableTable(["msgId", "Name"], [70], { zebra: true });
    for (const topic of summary.untrustedTopics) {
      const row = el("tr");
      row.appendChild(el("td", "num", String(topic.msgId)));
      row.appendChild(el("td", undefined, topic.name));
      untrustedTable.tbody.appendChild(row);
    }
    enableRowSelection(untrustedTable.tbody);
    pane.appendChild(untrustedTable.table);
  }

  pane.appendChild(el("h3", "section", `Dropouts (${summary.dropouts.length})`));
  if (summary.dropouts.length === 0) {
    pane.appendChild(el("div", "params-hint", "No dropouts detected — this log reports no gaps in its data section."));
  } else {
    const dropoutTable = makeResizableTable(["Time (s)", "Duration (ms)"], [140], { zebra: true });
    for (const dropout of summary.dropouts) {
      const row = el("tr");
      row.appendChild(el("td", "num", dropout.timeSec.toFixed(3)));
      row.appendChild(el("td", "num", dropout.durationMs.toLocaleString()));
      dropoutTable.tbody.appendChild(row);
    }
    enableRowSelection(dropoutTable.tbody);
    pane.appendChild(dropoutTable.table);
  }

  const applyStructureFilter = (filter: string) => {
    // The scroll pane is a flat list: an h3.section heading followed by its
    // content until the next heading. Group them back up so each section
    // can be shown or hidden as a unit.
    const groups: { heading: HTMLElement; members: HTMLElement[] }[] = [];
    for (const child of Array.from(pane.children) as HTMLElement[]) {
      if (child.matches("h3.section")) {
        groups.push({ heading: child, members: [] });
      } else if (groups.length > 0) {
        groups[groups.length - 1]!.members.push(child);
      }
    }
    const empty = filter.trim() === "";
    for (const group of groups) {
      const headingMatches = !empty && matchesSearchTerms(group.heading.textContent ?? "", filter);
      let visibleRows = 0;
      for (const member of group.members) {
        for (const tbody of member.querySelectorAll<HTMLElement>("tbody")) {
          visibleRows += filterTableRows(tbody, filter, headingMatches);
        }
      }
      // Row-less sections (the Overview stat tiles, "no dropouts" hints)
      // have nothing to match on, so they show only via their heading.
      const show = empty || headingMatches || visibleRows > 0;
      group.heading.style.display = show ? "" : "none";
      for (const member of group.members) {
        member.style.display = show ? "" : "none";
      }
    }
  };

  outerPane.appendChild(pane);
  return outerPane;
}

/* ---------------------------------------------------------------------- */
/* App shell                                                               */
/* ---------------------------------------------------------------------- */

function switchTab(name: string): void {
  state.currentTab = name;
  for (const button of app.querySelectorAll<HTMLElement>(".tabs button")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
  if (!builtPanes.has(name)) {
    const builder = lazyPaneBuilders.get(name);
    if (builder) {
      const pane = builder();
      builtPanes.set(name, pane);
      app.appendChild(pane);
    }
  }
  for (const pane of app.querySelectorAll<HTMLElement>(".tab-pane")) {
    pane.classList.toggle("active", pane.dataset.tab === name);
  }
  if (name === "data") {
    resizeAllCharts();
  }
}

function buildUi(summary: LogSummary): void {
  state.summary = summary;
  app.textContent = "";

  const topbar = el("header", "topbar");
  topbar.appendChild(el("span", "file-name", summary.fileName));
  const infoMap = new Map(summary.info);
  const metaParts = [
    formatDuration(summary.durationSec),
    formatFileSize(summary.fileSizeBytes),
    infoMap.get("sys_name"),
    infoMap.get("ver_sw_release") != undefined ? undefined : infoMap.get("ver_sw")?.slice(0, 12),
    infoMap.get("ver_hw"),
  ].filter((part): part is string => part != undefined && part !== "");
  topbar.appendChild(el("span", "file-meta", metaParts.join(" · ")));

  const tabs = el("nav", "tabs");
  const tabDefs: [string, string][] = [
    ["data", "Data"],
    ["replay", "Replay"],
    ["info", "Info"],
    ["parameters", `Parameters (${summary.parameters.length})`],
    ["messages", `Messages (${summary.logMessages.length})`],
    ["structure", "Structure"],
  ];
  for (const [id, label] of tabDefs) {
    const button = el("button", undefined, label);
    button.dataset.tab = id;
    button.addEventListener("click", () => switchTab(id));
    tabs.appendChild(button);
  }
  topbar.appendChild(tabs);
  app.appendChild(topbar);

  searchFocusByTab.clear();
  app.appendChild(buildPlotsPane());
  builtPanes.clear();
  lazyPaneBuilders.set("replay", () => buildReplayPane(summary));
  lazyPaneBuilders.set("info", () => buildInfoPane(summary));
  lazyPaneBuilders.set("parameters", () => buildParametersPane(summary));
  lazyPaneBuilders.set("messages", () => buildMessagesPane(summary));
  lazyPaneBuilders.set("structure", () => buildStructurePane(summary));

  renderTopicList();
  switchTab("data");
}

/* ---------------------------------------------------------------------- */
/* Host messages & bootstrap                                               */
/* ---------------------------------------------------------------------- */

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "summary":
      buildUi(message.summary);
      break;
    case "loadError": {
      app.textContent = "";
      app.appendChild(
        el("div", "centered-note error-note", `Failed to load ULog file: ${message.message}`),
      );
      break;
    }
    case "savedViews":
      state.savedViews = message.views;
      refreshSavedViewSelect();
      renderManageViewsList();
      break;
    case "viewRenamed":
      // Only updates in-memory state; the "savedViews" message that always
      // follows this one is what actually refreshes the selector/dialog,
      // once state.savedViews itself reflects the new name too.
      if (state.lockedSavedViewName === message.oldName) {
        state.lockedSavedViewName = message.newName;
      }
      break;
    case "viewSaved":
      // Same ordering reasoning as "viewRenamed" — locks onto the new view
      // now, so that by the time "savedViews" (always sent right after)
      // triggers refreshSavedViewSelect(), state.savedViews already
      // contains a match for this name.
      state.lockedSavedViewName = message.name;
      break;
    case "series": {
      const adHocKey = seriesKey(message.msgId, message.field);
      const adHoc = adHocSeriesResolvers.get(adHocKey);
      if (adHoc) {
        adHocSeriesResolvers.delete(adHocKey);
        adHoc.resolve({ times: new Float64Array(message.times), values: new Float64Array(message.values) });
      }
      addSeries(
        message.msgId,
        message.field,
        new Float64Array(message.times),
        new Float64Array(message.values),
      );
      break;
    }
    case "seriesError": {
      const adHocKey = seriesKey(message.msgId, message.field);
      const adHoc = adHocSeriesResolvers.get(adHocKey);
      if (adHoc) {
        adHocSeriesResolvers.delete(adHocKey);
        adHoc.reject(message.message);
      }
      const panel = state.panels.find((p) =>
        state.pending.has(pendingKey(p.id, message.msgId, message.field)),
      );
      if (panel) {
        state.pending.delete(pendingKey(panel.id, message.msgId, message.field));
      }
      setPlotStatus(`Failed to load ${message.field}: ${message.message}`);
      refreshFieldButtons();
      break;
    }
    case "strings": {
      state.pendingStrings.delete(message.msgId);
      state.stringsCache.set(message.msgId, message.data);
      populateStringsSection(message.msgId);
      break;
    }
    case "stringsError": {
      // Not cached: leaving it unfetched lets a later re-expand retry (a read
      // failure is usually transient), and avoids a cached empty result
      // later rendering every field as a misleading "(empty)".
      state.pendingStrings.delete(message.msgId);
      populateStringsSection(message.msgId, message.message);
      break;
    }
  }
});

// Re-resolve baked-in canvas colors when the VS Code theme changes.
new MutationObserver(() => {
  for (const panel of state.panels) {
    if (panel.series.length > 0) {
      rebuildPanelChart(panel);
    }
  }
  refreshFieldButtons();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

// Refetches saved views whenever this editor tab regains focus — e.g.
// switching back from another log's tab where a view got saved/renamed/
// deleted in the meantime. Deliberately NOT done on the select's own
// mousedown/click: rebuilding its <option>s while its native popup is
// already open (which a mousedown-triggered fetch landing moments later
// would do) can leave that popup unable to register a click on anything,
// since the browser's own open-popup state no longer matches the DOM it's
// showing. A focus event always happens well before the user gets to
// clicking the dropdown itself, so there's no such overlap.
window.addEventListener("focus", () => {
  vscode.postMessage({ type: "refreshSavedViews" });
});

app.appendChild(el("div", "centered-note", "Parsing ULog file…"));
vscode.postMessage({ type: "ready" });
