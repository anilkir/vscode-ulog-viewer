import * as vscode from "vscode";
import type { Filelike } from "@foxglove/ulog";
import { FileReader } from "@foxglove/ulog/node";
import { buildSummary, extractTopicColumns, extractTopicStrings, type TopicColumns } from "./ulogData";
import { scanUlogFile, type UlogFileScanResult } from "./paramScan";
import { log, logTimed } from "./logger";
import type {
  HostToWebviewMessage,
  SavedView,
  SavedViewPanelSpec,
  TopicStrings,
  WebviewToHostMessage,
} from "./protocol";

const SAVED_VIEWS_KEY = "ulogViewer.savedViews";

function getSavedViews(globalState: vscode.Memento): SavedView[] {
  return globalState.get<SavedView[]>(SAVED_VIEWS_KEY, []);
}

/** Prompts for a name and persists the given panel layout under it —
 *  overwriting silently if that name is already taken, matching ordinary
 *  "Save" (not "Save As") expectations. Returns undefined if the user
 *  cancelled the prompt, so the caller knows not to bother re-posting the
 *  (unchanged) view list. Also returns the chosen name, so the webview can
 *  lock its selector onto it. */
async function saveView(
  globalState: vscode.Memento,
  panels: SavedViewPanelSpec[],
): Promise<{ views: SavedView[]; name: string } | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: "Name this plotting view",
    placeHolder: "e.g. Attitude & Position",
    validateInput: (value) => (value.trim() === "" ? "Enter a name" : undefined),
  });
  if (!name) {
    return undefined;
  }
  const trimmedName = name.trim();
  const views = getSavedViews(globalState).filter((v) => v.name !== trimmedName);
  views.push({ name: trimmedName, panels });
  views.sort((a, b) => a.name.localeCompare(b.name));
  await globalState.update(SAVED_VIEWS_KEY, views);
  return { views, name: trimmedName };
}

/** Overwrites an already-saved view's panels in place, by exact name — no
 *  prompt, unlike saveView. Used by "Update View", once the webview has
 *  already established (via its own comparison) that the loaded view's
 *  plots have diverged from what's on disk. Returns undefined if that name
 *  no longer exists (e.g. deleted from another tab in the meantime). */
async function updateView(
  globalState: vscode.Memento,
  name: string,
  panels: SavedViewPanelSpec[],
): Promise<SavedView[] | undefined> {
  const views = getSavedViews(globalState);
  const existing = views.find((v) => v.name === name);
  if (!existing) {
    return undefined;
  }
  existing.panels = panels;
  await globalState.update(SAVED_VIEWS_KEY, views);
  return views;
}

/** Deletion is a real "delete a saved thing", unlike overwriting on save, so
 *  it gets its own confirmation — modal, since a background click dismissing
 *  it should count as "no", not "yes". */
async function deleteView(globalState: vscode.Memento, name: string): Promise<SavedView[] | undefined> {
  const confirmed = await vscode.window.showWarningMessage(
    `Delete the saved view "${name}"?`,
    { modal: true },
    "Delete",
  );
  if (confirmed !== "Delete") {
    return undefined;
  }
  const views = getSavedViews(globalState).filter((v) => v.name !== name);
  await globalState.update(SAVED_VIEWS_KEY, views);
  return views;
}

/** Renames a saved view in place (its panels are untouched), pre-filling the
 *  input box with the current name. Returns undefined if cancelled, if the
 *  name didn't actually change, or if the old name no longer exists. */
async function renameView(
  globalState: vscode.Memento,
  oldName: string,
): Promise<{ views: SavedView[]; newName: string } | undefined> {
  const existing = getSavedViews(globalState);
  const view = existing.find((v) => v.name === oldName);
  if (!view) {
    return undefined;
  }
  const newName = await vscode.window.showInputBox({
    prompt: "Rename saved view",
    value: oldName,
    valueSelection: [0, oldName.length],
    validateInput: (value) => (value.trim() === "" ? "Enter a name" : undefined),
  });
  if (!newName || newName.trim() === oldName) {
    return undefined;
  }
  const trimmedName = newName.trim();
  const views = existing.filter((v) => v.name !== oldName && v.name !== trimmedName);
  views.push({ name: trimmedName, panels: view.panels });
  views.sort((a, b) => a.name.localeCompare(b.name));
  await globalState.update(SAVED_VIEWS_KEY, views);
  return { views, newName: trimmedName };
}

/**
 * Wraps a Filelike to measure every read() call — count, total time, and
 * min/max/average per call. This is the single most useful diagnostic for
 * "parsing is slow": if per-call latency is high (network drive, remote-dev
 * filesystem, antivirus-scanned mount, etc.), it shows up directly here as
 * a large avg/max relative to the number of bytes moved, distinguishing
 * "the disk/network is slow" from "our own code is slow".
 */
class InstrumentedFilelike implements Filelike {
  private readCount = 0;
  private totalMs = 0;
  private minMs = Infinity;
  private maxMs = 0;
  private totalBytes = 0;
  private openPromise: Promise<number> | undefined;

  constructor(private readonly inner: Filelike) {}

  /**
   * Memoized: the initial `scan()` and any later per-topic `getTopicData()`
   * call both call this, and could race if a series is requested before the
   * summary scan resolves. The underlying Node FileReader only guards
   * against a *sequential* repeat open, not a concurrent one, so without
   * this both callers could race into two real `fs.open()` calls.
   */
  async open(): Promise<number> {
    if (!this.openPromise) {
      this.openPromise = this.inner.open();
    }
    return this.openPromise;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const t0 = Date.now();
    const result = await this.inner.read(offset, length);
    const dt = Date.now() - t0;
    this.readCount++;
    this.totalMs += dt;
    this.totalBytes += result.byteLength;
    if (dt < this.minMs) {
      this.minMs = dt;
    }
    if (dt > this.maxMs) {
      this.maxMs = dt;
    }
    return result;
  }

  size(): number {
    return this.inner.size();
  }

  /** Logs accumulated stats and resets the counters, so each logged phase
   *  (open vs. summary vs. a given series fetch) reports only its own reads. */
  logAndReset(label: string): void {
    if (this.readCount === 0) {
      log(`${label}: 0 read() calls`);
      return;
    }
    const avg = this.totalMs / this.readCount;
    const mb = (this.totalBytes / (1024 * 1024)).toFixed(1);
    log(
      `${label}: ${this.readCount} read() calls, ${mb}MB, ${this.totalMs}ms total ` +
        `(avg ${avg.toFixed(1)}ms, min ${this.minMs}ms, max ${this.maxMs}ms per call)`,
    );
    this.readCount = 0;
    this.totalMs = 0;
    this.totalBytes = 0;
    this.minMs = Infinity;
    this.maxMs = 0;
  }
}

export class UlogDocument implements vscode.CustomDocument {
  /**
   * Returns immediately — nothing is parsed here. Parsing happens lazily via
   * `scan()`, first triggered from the webview's "ready" handler in
   * `resolveCustomEditor` below. `scanUlogFile` (paramScan.ts) is fast
   * (well under a second even for large logs — see that module's docstring
   * for why), so unlike the old `ulog.open()`-based approach there's no
   * multi-second background parse to race against webview startup.
   */
  static create(uri: vscode.Uri): UlogDocument {
    log(`Opening ${uri.fsPath}`);
    const rawReader = new FileReader(uri.fsPath);
    const instrumented = new InstrumentedFilelike(rawReader);
    return new UlogDocument(uri, rawReader, instrumented);
  }

  private readonly topicCache = new Map<number, Promise<TopicColumns>>();
  private readonly stringCache = new Map<number, Promise<TopicStrings>>();
  private scanPromise: Promise<UlogFileScanResult> | undefined;

  private constructor(
    readonly uri: vscode.Uri,
    private readonly rawReader: FileReader,
    private readonly instrumented: InstrumentedFilelike,
  ) {}

  /** The already-open (instrumented) file handle, reusable for other low-level reads. */
  get filelike(): Filelike {
    return this.instrumented;
  }

  logReadStats(label: string): void {
    this.instrumented.logAndReset(label);
  }

  /**
   * Memoized: both the initial summary and every later per-topic
   * `getTopicData()` call need this same scan's parsed subscriptions/
   * definitions, so a log's header section is only ever parsed once.
   */
  scan(): Promise<UlogFileScanResult> {
    if (!this.scanPromise) {
      this.scanPromise = scanUlogFile(this.instrumented);
    }
    return this.scanPromise;
  }

  /** Extract (and cache) all plottable columns for a topic in a single pass. */
  getTopicData(msgId: number): Promise<TopicColumns> {
    let cached = this.topicCache.get(msgId);
    if (!cached) {
      cached = this.scan().then((scan) => extractTopicColumns(this.instrumented, scan, msgId));
      // Drop failed extractions so a later request can retry.
      cached.catch(() => this.topicCache.delete(msgId));
      this.topicCache.set(msgId, cached);
    }
    return cached;
  }

  /** Reconstruct (and cache) a topic's `char[N]` string fields' values. */
  getTopicStrings(msgId: number): Promise<TopicStrings> {
    let cached = this.stringCache.get(msgId);
    if (!cached) {
      cached = this.scan().then((scan) => extractTopicStrings(this.instrumented, scan, msgId));
      cached.catch(() => this.stringCache.delete(msgId));
      this.stringCache.set(msgId, cached);
    }
    return cached;
  }

  dispose(): void {
    this.topicCache.clear();
    this.stringCache.clear();
    void this.rawReader.close().catch(() => undefined);
  }
}

export class UlogEditorProvider implements vscode.CustomReadonlyEditorProvider<UlogDocument> {
  static readonly viewType = "ulogViewer.ulog";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      UlogEditorProvider.viewType,
      new UlogEditorProvider(context),
      {
        // The webview holds plot state (active series, zoom) that we don't
        // persist yet, so keep it alive while hidden.
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      },
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): UlogDocument {
    return UlogDocument.create(uri);
  }

  async resolveCustomEditor(document: UlogDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    webview.html = this.getHtml(webview);

    const post = (message: HostToWebviewMessage) => void webview.postMessage(message);

    const subscription = webview.onDidReceiveMessage(async (message: WebviewToHostMessage) => {
      switch (message.type) {
        case "ready": {
          const tReadyStart = Date.now();
          log("Webview ready, building summary…");
          try {
            const fileName = document.uri.path.split("/").pop() ?? document.uri.path;
            // vscode.workspace.fs.stat returns a Thenable (no .catch), so
            // wrap it: file size is informational only, never fatal.
            const fileSizeBytes = await Promise.resolve(vscode.workspace.fs.stat(document.uri)).then(
              (stat) => stat.size,
              () => 0,
            );
            const scan = await logTimed("scanUlogFile() (header parse + full-file indexing)", () =>
              document.scan(),
            );
            document.logReadStats("  reads during scanUlogFile()");
            const summary = buildSummary(scan, fileName, fileSizeBytes);
            // gps_dump's plottable fields (per-frame-type arrival-gap
            // series) only exist after decoding its raw stream, so fill
            // them in now — getTopicData caches the decoded columns, making
            // the plot requests that follow effectively free. Failure just
            // leaves the topic field-less; the summary still ships.
            for (const topic of summary.topics) {
              if (topic.messageName === "gps_dump" && topic.count > 0) {
                try {
                  const data = await logTimed(`gps_dump decode (msgId=${topic.msgId})`, () =>
                    document.getTopicData(topic.msgId),
                  );
                  topic.fields = [...data.columns.keys()].map((name) => ({ name, type: "double" }));
                } catch (err) {
                  log(`gps_dump decode failed for msgId=${topic.msgId}: ${errorMessage(err)}`);
                }
              }
            }
            log(`Total time from webview-ready to summary sent: ${Date.now() - tReadyStart}ms`);
            post({ type: "summary", summary });
            post({ type: "savedViews", views: getSavedViews(this.context.globalState) });
          } catch (err) {
            log(`Failed to build summary: ${errorMessage(err)}`);
            post({ type: "loadError", message: errorMessage(err) });
          }
          break;
        }
        case "saveView": {
          const result = await saveView(this.context.globalState, message.panels);
          if (result) {
            // Must precede "savedViews" — same reasoning as "viewRenamed"
            // below: the webview locks its selector onto this name, which
            // only works if it already knows the name before the (now
            // including-it) view list arrives.
            post({ type: "viewSaved", name: result.name });
            post({ type: "savedViews", views: result.views });
          }
          break;
        }
        case "updateView": {
          const views = await updateView(this.context.globalState, message.name, message.panels);
          if (views) {
            post({ type: "savedViews", views });
          }
          break;
        }
        case "deleteView": {
          const views = await deleteView(this.context.globalState, message.name);
          if (views) {
            post({ type: "savedViews", views });
          }
          break;
        }
        case "refreshSavedViews": {
          post({ type: "savedViews", views: getSavedViews(this.context.globalState) });
          break;
        }
        case "renameView": {
          const result = await renameView(this.context.globalState, message.oldName);
          if (result) {
            // Must precede "savedViews" — the webview uses this to update
            // any reference to the old name (e.g. its locked selector)
            // before the new view list arrives, otherwise it would briefly
            // look like the loaded view had simply vanished.
            post({ type: "viewRenamed", oldName: message.oldName, newName: result.newName });
            post({ type: "savedViews", views: result.views });
          }
          break;
        }
        case "getSeries": {
          const { msgId, field } = message;
          const t0 = Date.now();
          try {
            const data = await document.getTopicData(msgId);
            const values = data.columns.get(field);
            if (!values) {
              throw new Error(`Field "${field}" not found in topic ${msgId}`);
            }
            log(`getSeries msgId=${msgId} field="${field}": ${Date.now() - t0}ms (${data.times.length} rows)`);
            document.logReadStats(`  reads for msgId=${msgId}`);
            post({
              type: "series",
              msgId,
              field,
              // These arrays are always allocated locally, never SharedArrayBuffer.
              times: data.times.buffer as ArrayBuffer,
              values: values.buffer as ArrayBuffer,
            });
          } catch (err) {
            log(`getSeries msgId=${msgId} field="${field}" FAILED after ${Date.now() - t0}ms: ${errorMessage(err)}`);
            post({ type: "seriesError", msgId, field, message: errorMessage(err) });
          }
          break;
        }
        case "getStrings": {
          const { msgId } = message;
          const t0 = Date.now();
          try {
            const data = await document.getTopicStrings(msgId);
            log(
              `getStrings msgId=${msgId}: ${Date.now() - t0}ms ` +
                `(${data.fieldNames.length} field(s), ${data.records.length} record(s))`,
            );
            document.logReadStats(`  reads for strings msgId=${msgId}`);
            post({ type: "strings", msgId, data });
          } catch (err) {
            log(`getStrings msgId=${msgId} FAILED after ${Date.now() - t0}ms: ${errorMessage(err)}`);
            post({ type: "stringsError", msgId, message: errorMessage(err) });
          }
          break;
        }
      }
    });
    panel.onDidDispose(() => subscription.dispose());
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", file));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https://tile.openstreetmap.org;">
  <link rel="stylesheet" href="${distUri("webview.css")}">
  <title>ULog Viewer</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${distUri("webview.js")}"></script>
</body>
</html>`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
