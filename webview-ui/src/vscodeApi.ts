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

/**
 * Opens a URL in the user's real system browser via vscode.env.openExternal.
 * A plain `window.open()` call inside a VS Code webview does not reliably
 * open the system browser (webviews run in a sandboxed Electron context,
 * not a normal browser tab) -- OAuth login buttons need this instead.
 */
export function postOpenExternal(url: string) {
  getVsCodeApi().postMessage({ command: "openExternal", url });
}

// ── RTK request/response bridge ─────────────────────────────────────────────
// RTK state lives in the extension host (managed binary, PATH, `rtk` calls),
// not the backend, so the webview talks to it over postMessage. Each request
// carries a unique requestId the host echoes back so replies can be correlated.

export type RtkScope = "workspace" | "global";
export type RtkAction = "getStatus" | "setup" | "uninstall" | "refreshGain" | "removeManaged";

export interface RtkGainPeriod {
  period: string;
  commands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
}

export interface RtkGainSummary {
  totalCommands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
  totalTimeMs: number;
  avgTimeMs: number;
  daily: RtkGainPeriod[];
  weekly: RtkGainPeriod[];
  monthly: RtkGainPeriod[];
}

export interface RtkBinaryInfo {
  source: "path" | "managed";
  path: string;
  version: string;
  pathReady: boolean;
}

export interface RtkScopeStatus {
  configured: boolean;
  hookPath: string | null;
  instructionsPath: string | null;
  hookPinned: boolean;
}

export interface RtkStatus {
  platformSupported: boolean;
  binary: RtkBinaryInfo | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  conflictPath: string | null;
  restartRequired: boolean;
  workspace: RtkScopeStatus;
  global: RtkScopeStatus;
  warning: string | null;
}

export interface RtkResponse {
  command: "rtkResponse";
  requestId: string;
  ok: boolean;
  status?: RtkStatus;
  gain?: RtkGainSummary;
  error?: string;
  cancelled?: boolean;
}

let rtkSeq = 0;
const pendingRtk = new Map<string, (response: RtkResponse) => void>();
let rtkListenerAttached = false;

function ensureRtkListener() {
  if (rtkListenerAttached) return;
  rtkListenerAttached = true;
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as RtkResponse | undefined;
    if (data?.command !== "rtkResponse") return;
    const resolve = pendingRtk.get(data.requestId);
    if (resolve) {
      pendingRtk.delete(data.requestId);
      resolve(data);
    }
  });
}

/** Sends one RTK request to the extension host and resolves with its response. */
export function requestRtk(action: RtkAction, scope?: RtkScope, timeoutMs = 120_000): Promise<RtkResponse> {
  ensureRtkListener();
  const requestId = `rtk-${++rtkSeq}-${Date.now()}`;
  return new Promise<RtkResponse>((resolve) => {
    const timer = window.setTimeout(() => {
      pendingRtk.delete(requestId);
      resolve({ command: "rtkResponse", requestId, ok: false, error: "Request timed out." });
    }, timeoutMs);
    pendingRtk.set(requestId, (response) => {
      window.clearTimeout(timer);
      resolve(response);
    });
    getVsCodeApi().postMessage({ command: "rtk", requestId, action, scope });
  });
}
