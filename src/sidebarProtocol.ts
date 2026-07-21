/** Message protocol between the extension host and the sidebar's "ULog
 *  Files" webview view — separate from protocol.ts, which is the main
 *  per-file editor webview's own (unrelated) channel. */

export interface SidebarFileEntry {
  uriString: string;
  label: string;
  /** Only set for "Currently Open" entries, so re-opening focuses the
   *  existing tab in its own view column instead of possibly opening a
   *  second one. */
  viewColumn?: number;
}

/** Host -> sidebar webview. */
export interface SidebarUpdateMessage {
  type: "update";
  open: SidebarFileEntry[];
  recent: SidebarFileEntry[];
  workspace: SidebarFileEntry[];
}

/** Sidebar webview -> host. */
export type SidebarToHostMessage =
  | { type: "openFile" }
  | { type: "openExisting"; uriString: string; viewColumn?: number };
