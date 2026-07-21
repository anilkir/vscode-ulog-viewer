import * as vscode from "vscode";
import { UlogEditorProvider, getNonce } from "./ulogEditorProvider";
import type { SidebarFileEntry, SidebarToHostMessage } from "./sidebarProtocol";

const FILE_GLOB = "**/*.{ulg,ulog}";
const EXCLUDE_GLOB = "**/{node_modules,.git}/**";
const RECENT_FILES_KEY = "ulogViewer.recentFiles";
const MAX_RECENT_FILES = 15;

export function openUlogFile(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): void {
  void vscode.commands.executeCommand("vscode.openWith", uri, UlogEditorProvider.viewType, viewColumn);
}

export async function pickAndOpenFile(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { "ULog files": ["ulg", "ulog"] },
    openLabel: "Open ULog File",
  });
  if (picked?.[0]) {
    openUlogFile(picked[0]);
  }
}

/** Every currently-open ULog custom editor tab, across all editor groups. */
function findOpenUlogTabs(): { uri: vscode.Uri; label: string; viewColumn: vscode.ViewColumn }[] {
  const open: { uri: vscode.Uri; label: string; viewColumn: vscode.ViewColumn }[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputCustom && tab.input.viewType === UlogEditorProvider.viewType) {
        open.push({ uri: tab.input.uri, label: tab.label, viewColumn: group.viewColumn });
      }
    }
  }
  return open;
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function entryLabel(uri: vscode.Uri): string {
  return uri.path.split("/").pop() ?? uri.path;
}

/**
 * The "ULog Files" sidebar, as a custom webview view rather than a
 * TreeView. A TreeView can only get a real, prominent "Open ULog File"
 * button via `viewsWelcome`, which VS Code only renders while the tree has
 * zero children — it can't stay pinned above a non-empty file list, and a
 * second stacked view for just the button turned out to render as its own
 * collapsible (and collapsible-away) section, not a fixed element. A plain
 * webview sidesteps both: the button is just page content, always present.
 */
export class UlogFilesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "ulogViewer.filesView";

  private webviewView: vscode.WebviewView | undefined;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly tabsListener: vscode.Disposable;
  /** Snapshot of open ULog tabs as of the last tab-change event — a URI
   *  present now but absent here is what just got opened, and gets recorded
   *  into the persisted "recently opened" list below. */
  private knownOpenUriStrings: Set<string>;

  constructor(
    private readonly globalState: vscode.Memento,
    private readonly extensionUri: vscode.Uri,
  ) {
    const openNow = findOpenUlogTabs();
    this.knownOpenUriStrings = new Set(openNow.map((tab) => tab.uri.toString()));
    // Whatever's open right now clearly counts as "recently opened", even if
    // we can't tell whether it was opened *during* this activation — e.g. a
    // tab already open before a dev-host reload, or restored from a previous
    // session. onTabsChanged below only ever catches transitions that happen
    // while this instance is alive, which misses that case entirely.
    if (openNow.length > 0) {
      void this.recordRecent(openNow.map((tab) => tab.uri));
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(FILE_GLOB);
    this.watcher.onDidCreate(() => this.refresh());
    this.watcher.onDidDelete(() => this.refresh());
    this.watcher.onDidChange(() => this.refresh());
    this.tabsListener = vscode.window.tabGroups.onDidChangeTabs(() => this.onTabsChanged());
  }

  private onTabsChanged(): void {
    const openNow = findOpenUlogTabs();
    const newlyOpened = openNow.filter((tab) => !this.knownOpenUriStrings.has(tab.uri.toString()));
    this.knownOpenUriStrings = new Set(openNow.map((tab) => tab.uri.toString()));
    if (newlyOpened.length > 0) {
      void this.recordRecent(newlyOpened.map((tab) => tab.uri));
    } else {
      this.refresh();
    }
  }

  /** Moves each uri to the front of the persisted recent list (deduped),
   *  capped at MAX_RECENT_FILES. */
  private async recordRecent(uris: vscode.Uri[]): Promise<void> {
    let recent = this.globalState.get<string[]>(RECENT_FILES_KEY, []);
    for (const uri of uris) {
      const s = uri.toString();
      recent = [s, ...recent.filter((existing) => existing !== s)];
    }
    await this.globalState.update(RECENT_FILES_KEY, recent.slice(0, MAX_RECENT_FILES));
    this.refresh();
  }

  /** Recent entries, most-recently-opened first (order preserved, not
   *  alphabetized like the other two sections), minus whatever no longer
   *  exists on disk or is already shown in "Currently Open" — a file
   *  doesn't need to appear in both sections at once. */
  private async getRecentEntries(openUriStrings: Set<string>): Promise<SidebarFileEntry[]> {
    const stored = this.globalState.get<string[]>(RECENT_FILES_KEY, []);
    const uris = stored.map((s) => vscode.Uri.parse(s)).filter((uri) => !openUriStrings.has(uri.toString()));
    const exists = await Promise.all(uris.map(fileExists));
    return uris.filter((_uri, i) => exists[i]).map((uri) => ({ uriString: uri.toString(), label: entryLabel(uri) }));
  }

  refresh(): void {
    void this.postUpdate();
  }

  private async postUpdate(): Promise<void> {
    const webviewView = this.webviewView;
    if (!webviewView) {
      return;
    }
    const openTabs = findOpenUlogTabs();
    const open: SidebarFileEntry[] = openTabs
      .map((tab) => ({ uriString: tab.uri.toString(), label: tab.label, viewColumn: tab.viewColumn as number }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const openUriStrings = new Set(open.map((entry) => entry.uriString));
    const [recent, workspaceUris] = await Promise.all([
      this.getRecentEntries(openUriStrings),
      vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB),
    ]);
    const workspace: SidebarFileEntry[] = workspaceUris
      .map((uri) => ({ uriString: uri.toString(), label: entryLabel(uri) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    void webviewView.webview.postMessage({ type: "update", open, recent, workspace });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: SidebarToHostMessage) => {
      switch (message.type) {
        case "openFile":
          void pickAndOpenFile();
          break;
        case "openExisting":
          openUlogFile(vscode.Uri.parse(message.uriString), message.viewColumn as vscode.ViewColumn | undefined);
          break;
      }
    });
    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = undefined;
      }
    });
    void this.postUpdate();
  }

  private getHtml(webview: vscode.Webview): string {
    const distUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", file));
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${distUri("sidebar.css")}">
</head>
<body>
  <button id="openBtn" class="open-btn">Open ULog File</button>
  <div id="sections"></div>
  <script nonce="${nonce}" src="${distUri("sidebar.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.watcher.dispose();
    this.tabsListener.dispose();
  }
}
