import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

function getChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("ULog Viewer");
  }
  return channel;
}

export function log(message: string): void {
  const now = new Date();
  const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  getChannel().appendLine(`[${ts}.${String(now.getMilliseconds()).padStart(3, "0")}] ${message}`);
}

/** Times an async operation and logs how long it took, alongside the result. */
export async function logTimed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    log(`${label}: ${Date.now() - t0}ms`);
    return result;
  } catch (err) {
    log(`${label}: FAILED after ${Date.now() - t0}ms — ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}
