import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./style.css";
import type {
  HostToWebviewMessage,
  LogMessageInfo,
  LogSummary,
  ParameterInfo,
  SavedView,
  SavedViewPanelSpec,
  TopicInfo,
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
const ICON_PREV =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M10 3 L5 8 L10 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_NEXT =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M6 3 L11 8 L6 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_MARKER =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M4 14 V2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path d="M4 2 H12 L9.3 4.5 L12 7 H4" fill="currentColor"/></svg>';
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
  expandedTopics: Set<number>;
  topicFilter: string;
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
  expandedTopics: new Set(),
  topicFilter: "",
  parameterFilter: "",
  parameterQuickFilter: "all",
  currentTab: "plots",
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
// that DOM eagerly delayed showing the Plots tab, which is what a user
// almost always wants first. Build those three lazily, on first visit.
const lazyPaneBuilders = new Map<string, () => HTMLElement>();
const builtPanes = new Map<string, HTMLElement>();

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

/** The log's own start time as an absolute date, for the Info page — always
 *  UTC (unlike `formatWallClock`, which follows the Plots tab's own
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

/** A single boot-relative timestamp as an absolute UTC instant — same fixed-
 *  UTC convention as `formatUtcStartTime` (not the Plots tab's configurable
 *  timezone, since this is meant to be an unambiguous per-row fact), but
 *  without the trailing "UTC" label, since callers show many of these next
 *  to each other under a column/section already labeled that way. Returns
 *  "—" when this log has no GPS UTC reference, same as `formatWallClock`. */
function formatUtcTimestamp(rawBootRelativeSec: number): string {
  const utcOffsetUsec = state.summary?.utcOffsetUsec;
  if (utcOffsetUsec == undefined) {
    return "—";
  }
  const epochMs = (rawBootRelativeSec * US_PER_SEC + utcOffsetUsec) / 1000;
  if (!Number.isFinite(epochMs)) {
    return "—";
  }
  return new Date(epochMs).toISOString().replace("T", " ").replace("Z", "");
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
    if (filter !== "" && !topicMatches && matchingFields.length === 0) {
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
    });

    const fieldList = el("div", "field-list");
    for (const field of matchingFields) {
      const button = el("button", "field-btn");
      button.dataset.msgId = String(topic.msgId);
      button.dataset.field = field.name;
      button.appendChild(el("span", undefined, field.name));
      button.appendChild(el("span", "field-type", field.type));
      button.addEventListener("click", () => toggleField(topic, field.name));
      fieldList.appendChild(button);
    }
    if (matchingFields.length === 0) {
      fieldList.appendChild(el("div", "field-type", "no plottable fields"));
    }
    details.appendChild(fieldList);
    topicListEl.appendChild(details);
  }
  refreshFieldButtons();
}

/* ---------------------------------------------------------------------- */
/* Tab panes                                                               */
/* ---------------------------------------------------------------------- */

function makeFilterBox(placeholder: string, onInput: (value: string) => void): HTMLElement {
  const box = el("div", "filter-box");
  const input = el("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(input.value));
  box.appendChild(input);
  return box;
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

function buildPlotsPane(): HTMLElement {
  const pane = el("section", "tab-pane");
  pane.dataset.tab = "plots";

  const sidebar = el("aside", "sidebar");
  sidebar.appendChild(
    makeFilterBox("Filter topics and fields…", (value) => {
      state.topicFilter = value;
      renderTopicList();
    }),
  );
  topicListEl = el("div", "topic-list");
  sidebar.appendChild(topicListEl);
  pane.appendChild(sidebar);

  const resizer = el("div", "sidebar-resizer");
  resizer.title = "Drag to resize";
  pane.appendChild(resizer);
  setupSidebarResizer(resizer, sidebar);

  const plotPane = el("div", "plot-pane");
  const toolbar = el("div", "plot-toolbar");
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

  const fixedSection = el("div", "pane-fixed");
  fixedSection.appendChild(el("h3", "section", "General"));
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
  fixedSection.appendChild(el("h3", "section", "Log information"));
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
  const entries: { row: HTMLElement; message: LogMessageInfo }[] = [];
  for (const message of summary.logMessages) {
    const row = el("tr");
    const saneTime = message.timeSec >= 0 && message.timeSec <= maxSaneTime;
    const timeCell = el("td", "num time-cell");
    if (saneTime) {
      timeCell.appendChild(el("span", "time-cell-raw", message.timeSec.toFixed(3)));
      timeCell.appendChild(el("span", "time-cell-alt", `(${formatTimeTick(message.timeSec, 3)})`));
      if (utcAvailable) {
        timeCell.appendChild(el("span", "time-cell-utc", formatUtcTimestamp(message.timeSec)));
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
  const utcToggleBtn = el("button", undefined, "UTC") as HTMLButtonElement;
  utcToggleBtn.classList.toggle("disabled", !utcAvailable);
  utcToggleBtn.title = utcAvailable
    ? "Show each message's absolute UTC timestamp (from this log's GPS)"
    : (summary.utcUnavailableReason ?? "No GPS UTC reference available in this log");
  // The Time column's default 130px (sized for "753.146 (12:33.146)") is
  // too narrow for a full UTC datetime — widen it while the toggle is on,
  // restoring whatever width was there before (the default, or a manual
  // resize) rather than a hardcoded value, once it's off again.
  const timeCol = table.querySelector<HTMLElement>("colgroup col:first-child");
  let prevTimeColWidth: string | undefined;
  utcToggleBtn.addEventListener("click", () => {
    if (!utcAvailable) {
      return;
    }
    const next = !utcToggleBtn.classList.contains("active");
    utcToggleBtn.classList.toggle("active", next);
    table.classList.toggle("show-utc", next);
    if (timeCol) {
      if (next) {
        prevTimeColWidth = timeCol.style.width;
        timeCol.style.width = "210px";
      } else if (prevTimeColWidth != undefined) {
        timeCol.style.width = prevTimeColWidth;
      }
    }
  });
  toolbar.appendChild(utcToggleBtn);
  toolbar.appendChild(countLabel);
  toolbar.appendChild(el("span", "spacer"));
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
  if (name === "plots") {
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
    ["plots", "Plots"],
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

  app.appendChild(buildPlotsPane());
  builtPanes.clear();
  lazyPaneBuilders.set("info", () => buildInfoPane(summary));
  lazyPaneBuilders.set("parameters", () => buildParametersPane(summary));
  lazyPaneBuilders.set("messages", () => buildMessagesPane(summary));
  lazyPaneBuilders.set("structure", () => buildStructurePane(summary));

  renderTopicList();
  switchTab("plots");
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
    case "series":
      addSeries(
        message.msgId,
        message.field,
        new Float64Array(message.times),
        new Float64Array(message.values),
      );
      break;
    case "seriesError": {
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
