import * as vscode from "vscode";
import { UlogEditorProvider } from "./ulogEditorProvider";
import { UlogFilesViewProvider, pickAndOpenFile } from "./ulogFilesViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(UlogEditorProvider.register(context));

  const filesViewProvider = new UlogFilesViewProvider(context.globalState, context.extensionUri);
  context.subscriptions.push(
    filesViewProvider,
    vscode.window.registerWebviewViewProvider(UlogFilesViewProvider.viewType, filesViewProvider),
    vscode.commands.registerCommand("ulogViewer.openFile", pickAndOpenFile),
    vscode.commands.registerCommand("ulogViewer.refreshFiles", () => filesViewProvider.refresh()),
  );
}

export function deactivate(): void {}
