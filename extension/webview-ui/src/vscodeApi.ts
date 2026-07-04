// VS Code injects acquireVsCodeApi() into every webview automatically; it can
// only be called once per webview instance, so this module memoizes it.
declare function acquireVsCodeApi(): { postMessage: (message: unknown) => void };

let api: ReturnType<typeof acquireVsCodeApi> | null = null;

export function getVsCodeApi() {
  if (!api) api = acquireVsCodeApi();
  return api;
}

/** Asks the extension host to open the full dashboard as an editor-tab panel, optionally landing on a specific page. */
export function postOpenDashboardPanel(page?: string) {
  getVsCodeApi().postMessage({ command: "openDashboardPanel", page });
}

/** Mirrors the "Renn Copilot: Sync Models from Dashboard" command. */
export function postSyncModels() {
  getVsCodeApi().postMessage({ command: "syncModels" });
}

/** Mirrors the "Renn Copilot: Copy API Key to Clipboard" command. */
export function postCopyApiKey() {
  getVsCodeApi().postMessage({ command: "copyApiKey" });
}
