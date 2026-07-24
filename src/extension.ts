import * as vscode from "vscode";
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as backendManager from "./backend-manager";
import { openDashboardPanel } from "./webview-panel";
import { RennSidebarViewProvider, SIDEBAR_VIEW_ID } from "./webview-view";
import {
  PROVIDER_NAME,
  maskEmail,
  upsertProviderEntry,
  stripProviderEntry,
  type RemoteModelEntry,
  type ChatLanguageModelProvider,
} from "./provider-entry";

// As of VS Code's June 2026 BYOK overhaul, github.copilot.chat.customOAIModels
// (a settings.json key) is gone -- VS Code now refuses to even write it via
// the configuration API ("not a registered configuration"). The current
// mechanism is the "customendpoint" vendor, configured via a separate JSON
// file (User/chatLanguageModels.json in the VS Code profile dir).
// See https://code.visualstudio.com/docs/agent-customization/language-models
//
// Some VS Code builds don't render this provider's grouping / API-key prompt
// in "Chat: Manage Language Models" correctly (seen on a user's Mac install:
// models show up ungrouped, with no way to enter a key), so every chat
// request 401s forever since no Authorization header ever gets attached.
// rennCopilot.requireApiKey lets that case be worked around: when turned
// off, the backend is flipped (via setProxyAuthEnabled) to stop requiring
// its proxy API key at all, so it doesn't matter that VS Code never sends one.
function getRequireApiKey(): boolean {
  return vscode.workspace.getConfiguration("rennCopilot").get<boolean>("requireApiKey", false);
}

// Shape of the entries in GET /api/usage's `accounts` array -- one per
// stored OAuth credential file. `disabled` is a user/admin toggle off in
// CLIProxyAPI; `unavailable` is CLIProxyAPI's own "currently rate-limited /
// out of quota" flag. Either one means the account can't serve requests
// right now, even though the credential itself is still stored.
interface UsageAccount {
  name: string;
  label: string;
  provider: string;
  disabled: boolean;
  unavailable: boolean;
  next_retry_after: string | number | null;
}

// Shape of GET /api/usage's `apiKeys` array -- one per custom (non-OAuth)
// provider or extra Gemini/Claude/Codex API key. There's no disabled/quota
// concept for these upstream, so they're always counted as available. `name`
// is the matching openai-compatibility entry's own name (e.g. "minimax-m3"),
// null when there's no match -- falls back to the masked key.
interface UsageApiKey {
  provider: string;
  name: string | null;
  baseUrl: string | null;
  keyMasked: string;
}

// Unified shape both account and api-key entries get normalized into, so the
// status bar count/tooltip/quick-pick don't need to special-case which kind
// of credential they're looking at.
interface HealthEntry {
  label: string;
  provider: string;
  ok: boolean;
  disabled: boolean;
  next_retry_after: string | number | null;
}

let statusBarItem: vscode.StatusBarItem;
let healthStatusBarItem: vscode.StatusBarItem;
let healthTimer: ReturnType<typeof setInterval> | undefined;
let healthFastRetryTimer: ReturnType<typeof setTimeout> | undefined;
let healthFastRetriesLeft = 0;
let lastHealthAccounts: HealthEntry[] = [];
let syncQueue: Promise<void> = Promise.resolve();

// Watches chatLanguageModels.json so a manual edit/delete (e.g. the user
// removing our provider by hand, or another tool rewriting the file) triggers
// a reconcile right away instead of waiting up to SERVER_STATUS_POLL_MS.
let modelsFileWatcher: vscode.FileSystemWatcher | undefined;
let modelsFileDebounce: ReturnType<typeof setTimeout> | undefined;
// Set briefly around our own writes so the watcher can ignore the change it
// just caused -- otherwise every sync would immediately re-trigger a reconcile.
let ignoreNextModelsFileEvent = false;

// The models in chatLanguageModels.json are meant to mirror the CLIProxyAPI
// server's running state in realtime: present while it's up, gone the moment
// it stops (otherwise every Copilot chat request just 401s/fails against a
// dead proxy). We poll GET /api/server/status on a short cadence and only
// touch the file when `running` actually flips -- rewriting it every tick
// would needlessly reset VS Code's manually-entered API-key secret (see
// writeProviderEntry's doc comment).
let serverStatusTimer: ReturnType<typeof setInterval> | undefined;
let lastServerRunning: boolean | undefined;
const SERVER_STATUS_POLL_MS = 5000;

// While the backend/CLIProxyAPI are still spinning up (right after
// activation, or right after a manual/auto "start"), a health check can fail
// simply because the port isn't bound yet -- not a real problem. Rather than
// showing a stale "couldn't check" state for a full HEALTH_REFRESH_MS (30s),
// retry a few times at a much shorter interval until it succeeds.
const HEALTH_FAST_RETRY_MS = 2000;
const HEALTH_FAST_RETRY_MAX = 10; // ~20s of fast polling, then fall back to the normal 30s cadence

// Mirrors the dashboard's single global "Reveal emails" toggle (on the
// Providers page), persisted backend-side at GET/PUT /api/preferences -- so
// flipping it in the dashboard also unmasks (or re-masks) the emails shown
// here, without a separate per-row or per-app toggle to keep in sync.
let revealEmails = false;

const HEALTH_REFRESH_MS = 30_000;

// Kept module-level so chatLanguageModelsPath() can resolve the active VS Code
// profile's config dir (see its doc comment) without threading `context`
// through writeProviderEntry/removeProviderEntry and every one of their callers.
let extensionContext: vscode.ExtensionContext | undefined;

// Shape of GET /api/server/status: the CLIProxyAPI binary's running state plus
// its installed/latest version and whether an update is available (getStatus +
// getVersionStatus on the backend). Version fields are null when GitHub can't
// be reached, so the update indicator only shows when we actually know.
interface ServerStatus {
  running: boolean;
  installedVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
}

// Latest status seen from the backend, so the status bar can show the running
// CLIProxyAPI version and flag when a newer one is available.
let lastServerStatus: ServerStatus | undefined;

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "rennCopilot.syncModels";
  statusBarItem.text = "$(sync) Renn Copilot";
  statusBarItem.tooltip = "Click to sync models from the renn-copilot dashboard";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Separate item right next to the sync status: a quick green/red account
  // count so a quota/rate-limit issue is visible without opening the
  // dashboard. Click it for a per-account breakdown.
  healthStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  healthStatusBarItem.command = "rennCopilot.showHealthDetails";
  healthStatusBarItem.text = "$(loading~spin)";
  healthStatusBarItem.tooltip = "Checking provider account health...";
  healthStatusBarItem.show();
  context.subscriptions.push(healthStatusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.syncModels", () => syncModels(true))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.syncModelsInternal", () => syncModels(false))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.copyApiKey", copyApiKey)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.showHealthDetails", () => showHealthDetails(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.startBackend", () => startBackendCommand(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.stopBackend", stopBackendCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rennCopilot.openDashboardPanel", () => openDashboardPanel(context))
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new RennSidebarViewProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const config = vscode.workspace.getConfiguration("rennCopilot");

  if (config.get<boolean>("autoStartBackend", true)) {
    // Fire-and-forget -- don't block activation on the backend coming up.
    backendManager.startBackend(context);
    armHealthFastRetries();
  }

  if (config.get<boolean>("autoSyncOnStartup", true)) {
    // Don't block activation on the network call. Wait for the backend to
    // actually be reachable first -- right after activation (especially when
    // autoStartBackend just spawned it) the port isn't bound yet for the
    // first second or so, and a sync attempt during that window used to fail
    // outright with ECONNREFUSED instead of just... waiting a moment.
    const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
    void waitForBackendReady(backendUrl).then(() => reconcileModelsWithServer(true));
  }

  void refreshHealth();
  healthTimer = setInterval(() => void refreshHealth(), HEALTH_REFRESH_MS);

  // Keep chatLanguageModels.json in lockstep with the server's running state.
  serverStatusTimer = setInterval(() => void reconcileModelsWithServer(), SERVER_STATUS_POLL_MS);

  setupModelsFileWatcher();

  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });
  context.subscriptions.push({ dispose: () => clearTimeout(healthFastRetryTimer) });
  context.subscriptions.push({ dispose: () => clearInterval(serverStatusTimer) });
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(modelsFileDebounce);
      modelsFileWatcher?.dispose();
    },
  });
}

// Debounce window for watcher-driven reconciles: coalesces the burst of events
// an editor fires while saving into a single reconcile.
const MODELS_FILE_DEBOUNCE_MS = 500;

/**
 * Watches chatLanguageModels.json for out-of-band changes and reconciles when
 * one is seen. Skips events we caused ourselves (see ignoreNextModelsFileEvent)
 * and debounces to collapse a save's event burst into one reconcile.
 */
function setupModelsFileWatcher() {
  const filePath = chatLanguageModelsPath();
  modelsFileWatcher = vscode.workspace.createFileSystemWatcher(filePath);
  const onEvent = () => {
    if (ignoreNextModelsFileEvent) {
      ignoreNextModelsFileEvent = false;
      return;
    }
    clearTimeout(modelsFileDebounce);
    modelsFileDebounce = setTimeout(() => void reconcileModelsWithServer(true), MODELS_FILE_DEBOUNCE_MS);
  };
  modelsFileWatcher.onDidChange(onEvent);
  modelsFileWatcher.onDidCreate(onEvent);
  modelsFileWatcher.onDidDelete(onEvent);
}

export async function deactivate() {
  statusBarItem?.dispose();
  healthStatusBarItem?.dispose();
  clearInterval(healthTimer);
  clearInterval(serverStatusTimer);
  clearTimeout(healthFastRetryTimer);

  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");

  // The server is going down with us -- drop the models so a Copilot chat
  // launched before the backend is back up doesn't show a dead provider.
  // Do this *first* (it's synchronous): VS Code doesn't reliably await an
  // async deactivate() at shutdown, so if the process is killed mid-await
  // the file write below might never run.
  removeProviderEntry();
  await backendManager.stopBackend(backendUrl);
}

/** Polls the backend's root endpoint until it responds, or gives up after timeoutMs. */
async function waitForBackendReady(backendUrl: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetchJson(`${backendUrl}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function startBackendCommand(context: vscode.ExtensionContext) {
  if (backendManager.isRunning()) {
    void vscode.window.showInformationMessage("Renn Copilot: backend is already running.");
    return;
  }
  backendManager.startBackend(context);
  void vscode.window.showInformationMessage("Renn Copilot: starting backend...");
  armHealthFastRetries();
  // Once the backend (and, if autoStartServer is on, CLIProxyAPI) is reachable,
  // pull the models back in to match the now-running server.
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
  void waitForBackendReady(backendUrl).then(() => reconcileModelsWithServer(true));
}

async function stopBackendCommand() {
  if (!backendManager.isRunning()) {
    void vscode.window.showInformationMessage("Renn Copilot: backend is not running.");
    return;
  }
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
  void vscode.window.showInformationMessage("Renn Copilot: stopping backend...");
  await backendManager.stopBackend(backendUrl);
  // Backend (and the server it hosts) is down now -- reconcile removes the
  // models straight away instead of waiting for the next poll tick.
  await reconcileModelsWithServer(true);
  void refreshHealth();
}

/**
 * Polls the same /api/usage the dashboard's Usage page uses and reduces it
 * to a green-available / red-unavailable count for the status bar. Emoji
 * dots (not codicons) on purpose -- a StatusBarItem's `color` applies to the
 * whole item, so it's the only way to show two different colors in one item.
 */
async function refreshHealth() {
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");

  try {
    // Fetched alongside usage on every refresh cycle (every 30s, or whenever
    // a sync round-trips) rather than once at activation, so toggling it in
    // the dashboard takes effect here without reloading the window.
    const preferences = await fetchJson<{ revealEmails: boolean }>(`${backendUrl}/api/preferences`).catch(
      () => ({ revealEmails })
    );
    revealEmails = preferences.revealEmails;

    const usage = await fetchJson<{ accounts: UsageAccount[]; apiKeys: UsageApiKey[] }>(
      `${backendUrl}/api/usage`
    );
    const accountEntries: HealthEntry[] = (usage.accounts ?? []).map((a) => ({
      label: revealEmails ? a.label : maskEmail(a.label),
      provider: a.provider,
      ok: !a.disabled && !a.unavailable,
      disabled: a.disabled,
      next_retry_after: a.next_retry_after,
    }));
    // Custom providers / extra API keys have no disabled/quota concept
    // upstream -- always "ok", matching the dashboard Usage page's Health
    // monitor card, which is what this status bar is meant to mirror.
    const apiKeyEntries: HealthEntry[] = (usage.apiKeys ?? []).map((k) => ({
      label: k.name || k.keyMasked,
      provider: k.provider,
      ok: true,
      disabled: false,
      next_retry_after: null,
    }));
    lastHealthAccounts = [...accountEntries, ...apiKeyEntries];

    if (!lastHealthAccounts.length) {
      healthStatusBarItem.text = "$(circle-outline) No accounts";
      healthStatusBarItem.tooltip = "No stored provider accounts yet. Click to open the dashboard.";
      return;
    }

    const available = lastHealthAccounts.filter((a) => a.ok).length;
    const unavailable = lastHealthAccounts.length - available;

    healthStatusBarItem.text = unavailable > 0 ? `🟢 ${available}  🔴 ${unavailable}` : `🟢 ${available}`;
    healthStatusBarItem.tooltip = buildHealthTooltip();
    healthFastRetriesLeft = 0; // reachable again -- stop any fast-retry loop in flight
  } catch (err: any) {
    healthStatusBarItem.text = "⚪ --";
    healthStatusBarItem.tooltip = `Renn Copilot: couldn't check account health (${err.message}). Is the backend running?`;
    if (healthFastRetriesLeft > 0) {
      healthFastRetriesLeft--;
      clearTimeout(healthFastRetryTimer);
      healthFastRetryTimer = setTimeout(() => void refreshHealth(), HEALTH_FAST_RETRY_MS);
    }
  }
}

/** Arms a burst of fast retries -- call whenever the backend is known to be (re)starting. */
function armHealthFastRetries() {
  healthFastRetriesLeft = HEALTH_FAST_RETRY_MAX;
  clearTimeout(healthFastRetryTimer);
  healthFastRetryTimer = setTimeout(() => void refreshHealth(), HEALTH_FAST_RETRY_MS);
}

function buildHealthTooltip(): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Provider account health**\n\n`);
  for (const a of lastHealthAccounts) {
    const dot = a.ok ? "🟢" : "🔴";
    let status = a.ok ? "Available" : a.disabled ? "Disabled" : "Unavailable";
    if (!a.ok && a.next_retry_after) status += ` — retry after ${a.next_retry_after}`;
    md.appendMarkdown(`${dot} **${a.label}** _(${a.provider})_ — ${status}\n\n`);
  }
  md.appendMarkdown(`Click for details.`);
  return md;
}

async function showHealthDetails(context: vscode.ExtensionContext) {
  if (!lastHealthAccounts.length) {
    const choice = await vscode.window.showInformationMessage(
      "Renn Copilot: no stored provider accounts found yet.",
      "Open Dashboard"
    );
    if (choice === "Open Dashboard") openDashboardPanel(context);
    return;
  }

  const items: vscode.QuickPickItem[] = lastHealthAccounts.map((a) => {
    let detail = a.ok ? "Available" : a.disabled ? "Disabled" : "Unavailable";
    if (!a.ok && a.next_retry_after) detail += ` — retry after ${a.next_retry_after}`;
    return {
      label: `${a.ok ? "$(pass-filled)" : "$(error)"} ${a.label}`,
      description: a.provider,
      detail,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: "Renn Copilot — provider account health",
    placeHolder: "Select an account to open the dashboard's Providers page (login/quota actions)",
  });
  if (picked) openDashboardPanel(context);
}

/**
 * Fetches the current proxy API key from the backend and puts it on the
 * clipboard, so the user can paste it straight into VS Code's "Chat: Manage
 * Language Models" dialog -- the one place that actually needs it, since
 * the Custom Endpoint provider's apiKey field in chatLanguageModels.json is
 * not read at request time (see writeProviderEntry's comment).
 */
async function copyApiKey() {
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");

  try {
    const remote = await fetchJson<{ models: RemoteModelEntry[]; apiKey?: string }>(
      `${backendUrl}/api/models/export`
    );
    if (!remote.apiKey) {
      void vscode.window.showWarningMessage(
        "Renn Copilot: backend didn't return an API key. Is it running and has it started CLIProxyAPI at least once?"
      );
      return;
    }
    await vscode.env.clipboard.writeText(remote.apiKey);
    const message = `Renn Copilot: API key copied to clipboard. Open "Chat: Manage Language Models", pick "${PROVIDER_NAME}", and paste it in.`;
    void vscode.window.setStatusBarMessage(message, 5000);
  } catch (err: any) {
    void vscode.window.showErrorMessage(`Renn Copilot: couldn't fetch API key (${err.message}). Is the backend running?`);
  }
}

function syncModels(showNotifications: boolean): Promise<void> {
  // Model toggles, capability updates, startup sync, and manual sync can all
  // arrive close together. Serialize them so an older export can never
  // finish last and overwrite chatLanguageModels.json with stale content.
  const next = syncQueue.then(() => performSyncModels(showNotifications));
  syncQueue = next.catch(() => undefined);
  return next;
}

async function performSyncModels(showNotifications: boolean) {
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
  const requireApiKey = getRequireApiKey();

  // The provider entry mirrors the CLIProxyAPI server: no server, no models.
  // Writing them while the proxy is down would only leave Copilot chat with a
  // provider whose every request fails. When it's stopped (or the backend is
  // unreachable, so it can't be running) we remove the entry instead.
  if (!(await isServerRunning(backendUrl))) {
    lastServerRunning = false;
    const { removed } = removeProviderEntry();
    statusBarItem.text = "$(circle-slash) Renn Copilot";
    statusBarItem.tooltip = "CLIProxyAPI server is stopped -- start it to sync models into Copilot chat.";
    void refreshHealth();
    if (showNotifications) {
      void vscode.window.showInformationMessage(
        removed
          ? `Renn Copilot: server is stopped -- removed the "${PROVIDER_NAME}" models from Copilot chat.`
          : `Renn Copilot: server is stopped, so there's nothing to sync. Start it from the dashboard first.`
      );
    }
    return;
  }

  lastServerRunning = true;
  statusBarItem.text = "$(sync~spin) Renn Copilot";
  try {
    const remote = await fetchJson<{ models: RemoteModelEntry[]; apiKey?: string }>(
      `${backendUrl}/api/models/export`
    );

    // When the user has turned off requireApiKey (their VS Code build isn't
    // prompting for one at all -- see the doc comment above), tell the
    // backend to stop requiring its proxy API key too, so it doesn't matter
    // that no Authorization header is ever attached to chat requests.
    await putJson(`${backendUrl}/api/server/proxy-auth`, { enabled: requireApiKey }).catch(() => {
      // Non-fatal -- the backend might not be reachable for this call even
      // though /api/models/export just succeeded (rare race); the model
      // sync below still proceeds either way.
    });

    const { created, changed } = writeProviderEntry(remote.models, requireApiKey ? remote.apiKey ?? "" : "");

    const version = versionStatusBarSuffix();
    statusBarItem.text = `$(check) Renn Copilot (${remote.models.length})${version.text}`;
    statusBarItem.tooltip =
      (changed
        ? `Synced ${remote.models.length} model(s) into chatLanguageModels.json. Click to re-sync.`
        : `Already up to date (${remote.models.length} model(s)). Click to re-sync.`) + version.tooltip;

    // A sync round-trip means the backend is reachable -- piggyback a health
    // refresh on it so the dot count doesn't lag behind a manual re-sync.
    void refreshHealth();

    // Only touch the clipboard when the provider entry actually changed --
    // that's exactly the case where VS Code will need the key re-pasted
    // (a brand new entry, or an existing one whose content moved). A no-op
    // sync means the file (and therefore any previously-entered key) is
    // untouched, so overwriting the user's clipboard on every silent
    // startup sync would just be an annoying side effect for no reason.
    if (requireApiKey && changed && remote.apiKey) {
      await vscode.env.clipboard.writeText(remote.apiKey);
    }

    if (showNotifications) {
      if (!changed) {
        // Nothing actually changed -- don't touch the file (see writeProviderEntry's
        // comment on why) and don't bother the user with a no-op notification.
        return;
      }
      const keyNote = !requireApiKey
        ? `No API key needed -- rennCopilot.requireApiKey is off, so the backend now runs without proxy authentication.`
        : remote.apiKey
          ? `The API key was copied to your clipboard -- paste it in with Ctrl+V (Cmd+V on Mac) and press Enter.`
          : `Backend didn't return an API key yet -- run "Renn Copilot: Copy API Key to Clipboard" once it has.`;
      if (created) {
        const reload = "Reload Window";
        const message =
          `Added "${PROVIDER_NAME}" as a new Custom Endpoint provider with ${remote.models.length} model(s). ` +
          `Reload VS Code, then check the model picker. ${keyNote}`;
        const choice = await vscode.window.showInformationMessage(message, reload);
        if (choice === reload) {
          void vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      } else {
        void vscode.window.showInformationMessage(
          `Synced ${remote.models.length} model(s) into the "${PROVIDER_NAME}" Custom Endpoint provider. ` +
            `If the model picker does not refresh automatically, reload VS Code. ${keyNote}`
        );
      }
    } else if (requireApiKey && changed && remote.apiKey) {
      // Silent startup sync that still changed the file (e.g. the very
      // first sync after installing) -- a toast is warranted here since
      // there's no other visible feedback, but keep it short.
      void vscode.window.showInformationMessage(
        `Renn Copilot: synced ${remote.models.length} model(s). API key copied to clipboard -- paste it into "Chat: Manage Language Models" when prompted.`
      );
    }
  } catch (err: any) {
    statusBarItem.text = "$(error) Renn Copilot";
    statusBarItem.tooltip = `Sync failed: ${err.message}`;
    void refreshHealth();
    if (showNotifications) {
      void vscode.window.showErrorMessage(
        `Renn Copilot: sync failed (${err.message}). Is the backend running, and is VS Code's ` +
          `chatLanguageModels.json location writable?`
      );
    }
  }
}

/**
 * Locates chatLanguageModels.json for the running VS Code build. On the
 * default profile it's under User/; on a named profile VS Code stores config
 * under User/profiles/<id>/ instead. We detect that case from
 * context.globalStorageUri (see profileDirFromContext),
 * so a user on a named profile gets their profile's file rather than the
 * default one -- falling back to the default User/ dir when no profile can be
 * determined (e.g. context isn't available yet).
 */
function chatLanguageModelsPath(): string {
  const folderByAppName: Record<string, string> = {
    "Visual Studio Code": "Code",
    "Visual Studio Code - Insiders": "Code - Insiders",
    "Visual Studio Code - Exploration": "Code - Exploration",
    VSCodium: "VSCodium",
  };
  const folderName = folderByAppName[vscode.env.appName] ?? "Code";

  let base: string;
  if (process.platform === "win32") {
    base = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support");
  } else {
    base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  }

  const userDir = path.join(base, folderName, "User");
  const profileDir = profileDirFromContext();
  return path.join(profileDir ?? userDir, "chatLanguageModels.json");
}

/**
 * Resolves the active profile's config dir (User/profiles/<id>) when the
 * window is running under a named VS Code profile. There's no direct API for
 * the active profile id, but context.globalStorageUri encodes it: for the
 * default profile it's ".../User/globalStorage/<extId>", and for a named
 * profile ".../User/profiles/<id>/globalStorage/<extId>". We walk up from the
 * globalStorage segment and, if the parent is a "profiles/<id>" dir, use it.
 * Returns undefined for the default profile (or if context isn't set yet), so
 * the caller falls back to the plain User/ dir.
 */
function profileDirFromContext(): string | undefined {
  const globalStorage = extensionContext?.globalStorageUri?.fsPath;
  if (!globalStorage) return undefined;
  // .../User/profiles/<id>/globalStorage/<extId>  ->  profileRoot = .../User/profiles/<id>
  const profileRoot = path.dirname(path.dirname(globalStorage));
  if (path.basename(path.dirname(profileRoot)) === "profiles") return profileRoot;
  return undefined;
}

/**
 * Reads chatLanguageModels.json, replaces (or creates) the single provider
 * entry this extension owns, and writes the file back. We own the whole
 * entry -- not just a tagged subset of it, like the old customOAIModels
 * approach did -- because the new schema keys the API key at the provider
 * level, so there's nothing else here for the user to hand-edit alongside us.
 *
 * IMPORTANT: VS Code does NOT actually read `apiKey` from this file at
 * request time -- empirically (captured via a logging proxy), the
 * Authorization header sent for chat requests was just "Bearer" with no
 * token, even though this file's apiKey field was correct. The real,
 * working credential is whatever the user pastes into "Chat: Manage
 * Language Models" (stored in VS Code's own Secret Storage). All we
 * actually own here is the model list + provider metadata.
 *
 * Because of that, we must NOT rewrite this file on every activation --
 * doing so (even with byte-identical content) touches mtime/triggers VS
 * Code's file watcher, which appears to invalidate/reset that manually-
 * entered secret, forcing the user to re-paste their API key on every
 * reload. So: skip the write entirely if the computed entry is identical
 * to what's already on disk.
 */
function writeProviderEntry(models: RemoteModelEntry[], apiKey: string): { created: boolean; changed: boolean } {
  const filePath = chatLanguageModelsPath();
  let providers: ChatLanguageModelProvider[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) providers = parsed;
  } catch {
    // File doesn't exist yet, or isn't valid JSON -- start fresh.
    providers = [];
  }

  const { providers: next, created, changed } = upsertProviderEntry(providers, models, apiKey);
  if (!changed) return { created: false, changed: false };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  ignoreNextModelsFileEvent = true;
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return { created, changed: true };
}

/**
 * Removes the single provider entry this extension owns from
 * chatLanguageModels.json, leaving any other providers the user set up
 * untouched. Like writeProviderEntry, it only writes the file back when it
 * actually removed something -- an unconditional rewrite would reset VS
 * Code's manually-entered API-key secret (see writeProviderEntry's comment),
 * and this runs on every poll tick while the server is down.
 */
function removeProviderEntry(): { removed: boolean } {
  const filePath = chatLanguageModelsPath();
  let providers: ChatLanguageModelProvider[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) providers = parsed;
  } catch {
    // Nothing on disk (or unparseable) -- nothing of ours to remove.
    return { removed: false };
  }

  const { providers: next, removed } = stripProviderEntry(providers);
  if (!removed) return { removed: false };

  ignoreNextModelsFileEvent = true;
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), "utf8");
  return { removed: true };
}

/** True only when the backend is reachable AND reports the CLIProxyAPI server up. */
async function isServerRunning(backendUrl: string): Promise<boolean> {
  try {
    const status = await fetchJson<ServerStatus>(`${backendUrl}/api/server/status`);
    lastServerStatus = status;
    return !!status.running;
  } catch {
    // Backend unreachable -> the server it hosts can't be running either, and
    // we have no fresh version info to show.
    lastServerStatus = undefined;
    return false;
  }
}

/**
 * Builds the version/update suffix for the status bar text and tooltip from the
 * last status we saw. Returns empty strings when no version is known (e.g.
 * GitHub was unreachable), so the caller can append unconditionally.
 */
function versionStatusBarSuffix(): { text: string; tooltip: string } {
  const status = lastServerStatus;
  if (!status?.installedVersion) return { text: "", tooltip: "" };
  if (status.updateAvailable && status.latestVersion) {
    return {
      text: " $(arrow-up)",
      tooltip: `\nCLIProxyAPI ${status.installedVersion} -- update available (${status.latestVersion}).`,
    };
  }
  return { text: "", tooltip: `\nCLIProxyAPI ${status.installedVersion} (up to date).` };
}

/**
 * Keeps chatLanguageModels.json in sync with the server's running state.
 * Called on a short poll timer (and forced after explicit start/stop), it
 * only acts when `running` actually flips -- so a steady-state server (up or
 * down) never rewrites the file, preserving VS Code's stored API-key secret.
 * Pass force=true to run the reconcile even without a detected transition
 * (e.g. right after activation, when lastServerRunning is still unknown).
 */
async function reconcileModelsWithServer(force = false): Promise<void> {
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");

  const running = await isServerRunning(backendUrl);
  if (!force && running === lastServerRunning) return;
  lastServerRunning = running;

  if (running) {
    // performSyncModels re-checks status and writes the model list (a no-op
    // if nothing changed). Routed through syncModels so it stays serialized
    // with manual/webview syncs.
    await syncModels(false);
  } else {
    const { removed } = removeProviderEntry();
    statusBarItem.text = "$(circle-slash) Renn Copilot";
    statusBarItem.tooltip = "CLIProxyAPI server is stopped -- start it to sync models into Copilot chat.";
    if (removed) void refreshHealth();
  }
}

// A transient failure (network hiccup, timeout, or a 5xx while the backend is
// still coming up) is worth a quick retry; a 4xx is a real answer and isn't.
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_BACKOFF_BASE_MS = 250; // 250ms, 500ms between the 3 attempts

function isRetriableFetchError(err: unknown): boolean {
  const status = (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number") return status >= 500;
  // No status attached -> transport-level failure (ECONNREFUSED, timeout, ...).
  return true;
}

/**
 * fetchJson with a short retry/backoff for transient failures. 4xx responses
 * reject immediately (they won't change on retry); network errors, timeouts,
 * and 5xx get up to FETCH_MAX_ATTEMPTS tries with exponential backoff.
 */
async function fetchJson<T>(url: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchJsonOnce<T>(url);
    } catch (err) {
      lastErr = err;
      if (!isRetriableFetchError(err) || attempt === FETCH_MAX_ATTEMPTS - 1) break;
      await new Promise((r) => setTimeout(r, FETCH_BACKOFF_BASE_MS * 2 ** attempt));
    }
  }
  throw lastErr;
}

function fetchJsonOnce<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        // Attach statusCode so fetchJson can tell 4xx (final) from 5xx (retriable).
        reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
        res.resume();
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

function putJson(url: string, body: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
        timeout: 5000,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
        res.resume();
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(payload);
  });
}
