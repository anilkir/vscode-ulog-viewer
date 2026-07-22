import "./style.css";
import type { SidebarFileEntry, SidebarToHostMessage, SidebarUpdateMessage } from "../sidebarProtocol";

declare function acquireVsCodeApi(): {
  postMessage(message: SidebarToHostMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
};

const vscode = acquireVsCodeApi();

const openBtn = document.getElementById("openBtn") as HTMLButtonElement;
openBtn.addEventListener("click", () => vscode.postMessage({ type: "openFile" }));

const openFolderBtn = document.getElementById("openFolderBtn") as HTMLButtonElement;
openFolderBtn.addEventListener("click", () => vscode.postMessage({ type: "openFolder" }));

const sectionsEl = document.getElementById("sections") as HTMLElement;

/* Small accent glyphs so each section card is identifiable at a glance. */
const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path d="M1.5 4.25 A1.25 1.25 0 0 1 2.75 3 H6 l1.4 1.5 H13.25 A1.25 1.25 0 0 1 14.5 5.75 V11.75 ' +
  'A1.25 1.25 0 0 1 13.25 13 H2.75 A1.25 1.25 0 0 1 1.5 11.75 Z" fill="currentColor"/></svg>';
const OPEN_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path d="M4 1.75 H9 L12.5 5.25 V14.25 H4 Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
  '<path d="M9 1.75 V5.25 H12.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const CLOCK_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<path d="M8 4.5 V8 L10.5 9.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const WORKSPACE_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<rect x="2" y="5" width="12" height="8.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>' +
  '<path d="M6 5 V3.75 A0.75 0.75 0 0 1 6.75 3 H9.25 A0.75 0.75 0 0 1 10 3.75 V5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

function makeFileRow(entry: SidebarFileEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "file-row";
  row.textContent = entry.label;
  row.title = decodeURIComponent(entry.uriString);
  row.addEventListener("click", () => {
    vscode.postMessage({ type: "openExisting", uriString: entry.uriString, viewColumn: entry.viewColumn });
  });
  return row;
}

interface CardOptions {
  title: string;
  icon: string;
  entries: SidebarFileEntry[];
  /** Tooltip for the title (e.g. the full folder path). */
  titleTooltip?: string;
  /** When set, the card renders even with no entries, showing this hint —
   *  used by the folder card so its clear button stays reachable. */
  emptyHint?: string;
  /** Adds a ✕ button that clears the picked folder. */
  clearable?: boolean;
}

/** One section rendered as a bordered card: an accent icon, a bright header,
 *  then its file rows. Returns undefined for an empty card unless it has an
 *  `emptyHint` (so ordinary sections just disappear when empty). */
function renderCard(opts: CardOptions): HTMLElement | undefined {
  if (opts.entries.length === 0 && opts.emptyHint == undefined) {
    return undefined;
  }
  const wrap = document.createElement("div");
  wrap.className = "section-card";

  const header = document.createElement("div");
  header.className = "section-header";
  const icon = document.createElement("span");
  icon.className = "section-icon";
  icon.innerHTML = opts.icon;
  header.appendChild(icon);
  const title = document.createElement("span");
  title.className = "section-title";
  title.textContent = opts.title;
  if (opts.titleTooltip != undefined) {
    title.title = opts.titleTooltip;
  }
  header.appendChild(title);
  if (opts.clearable) {
    const clearBtn = document.createElement("button");
    clearBtn.className = "folder-clear";
    clearBtn.textContent = "✕";
    clearBtn.title = "Clear this folder";
    clearBtn.addEventListener("click", () => vscode.postMessage({ type: "clearFolder" }));
    header.appendChild(clearBtn);
  }
  wrap.appendChild(header);

  if (opts.entries.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = opts.emptyHint ?? "";
    wrap.appendChild(hint);
  } else {
    for (const entry of opts.entries) {
      wrap.appendChild(makeFileRow(entry));
    }
  }
  return wrap;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

window.addEventListener("message", (event: MessageEvent<SidebarUpdateMessage>) => {
  const message = event.data;
  if (message.type !== "update") {
    return;
  }
  sectionsEl.textContent = "";
  const sections = [
    // Picked folder first — it's the user's own explicit selection.
    message.folderPath != undefined
      ? renderCard({
          title: folderName(message.folderPath),
          titleTooltip: message.folderPath,
          icon: FOLDER_ICON,
          entries: message.folder,
          emptyHint: "No .ulg or .ulog files in this folder.",
          clearable: true,
        })
      : undefined,
    renderCard({ title: "Currently Open", icon: OPEN_ICON, entries: message.open }),
    renderCard({ title: "Recently Opened", icon: CLOCK_ICON, entries: message.recent }),
    renderCard({ title: "Workspace Files", icon: WORKSPACE_ICON, entries: message.workspace }),
  ].filter((s): s is HTMLElement => s != undefined);

  if (sections.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent =
      "No .ulg or .ulog files open, recently opened, or found. Use “Open Folder” to list a folder’s logs.";
    sectionsEl.appendChild(hint);
    return;
  }
  for (const section of sections) {
    sectionsEl.appendChild(section);
  }
});
