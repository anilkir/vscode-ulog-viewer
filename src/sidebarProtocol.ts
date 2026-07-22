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
  /** ULog files found (recursively) under the user-picked folder — see the
   *  sidebar's "Open Folder" button. Empty when no folder is picked. */
  folder: SidebarFileEntry[];
  /** Filesystem path of the picked folder, for the section header/tooltip;
   *  undefined when none is picked (the folder section isn't shown then). */
  folderPath?: string;
}

/** Sidebar webview -> host. */
export type SidebarToHostMessage =
  | { type: "openFile" }
  /** Pick a folder to scan for ULog files (shown in the folder section). */
  | { type: "openFolder" }
  /** Forget the picked folder and hide its section. */
  | { type: "clearFolder" }
  | { type: "openExisting"; uriString: string; viewColumn?: number };
