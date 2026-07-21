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

const sectionsEl = document.getElementById("sections") as HTMLElement;

function renderSection(title: string, entries: SidebarFileEntry[]): HTMLElement | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const wrap = document.createElement("div");
  const header = document.createElement("div");
  header.className = "section-header";
  header.textContent = title;
  wrap.appendChild(header);
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "file-row";
    row.textContent = entry.label;
    row.title = decodeURIComponent(entry.uriString);
    row.addEventListener("click", () => {
      vscode.postMessage({ type: "openExisting", uriString: entry.uriString, viewColumn: entry.viewColumn });
    });
    wrap.appendChild(row);
  }
  return wrap;
}

window.addEventListener("message", (event: MessageEvent<SidebarUpdateMessage>) => {
  const message = event.data;
  if (message.type !== "update") {
    return;
  }
  sectionsEl.textContent = "";
  const sections = [
    renderSection("Currently Open", message.open),
    renderSection("Recently Opened", message.recent),
    renderSection("Workspace Files", message.workspace),
  ].filter((s): s is HTMLElement => s != undefined);

  if (sections.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "No .ulg or .ulog files open, recently opened, or found in this workspace.";
    sectionsEl.appendChild(hint);
    return;
  }
  for (const section of sections) {
    sectionsEl.appendChild(section);
  }
});
