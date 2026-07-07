import * as vscode from "vscode";
import * as https from "node:https";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as backendManager from "./backend-manager";
import { openDashboardPanel } from "./webview-panel";
import { RennSidebarViewProvider, SIDEBAR_VIEW_ID } from "./webview-view";

// As of VS Code's June 2026 BYOK overhaul, github.copilot.chat.customOAIModels
// (a settings.json key) is gone -- VS Code now refuses to even write it via
// the configuration API ("not a registered configuration"). The current,
// recommended mechanism is the "customendpoint" vendor in chatLanguageModels.json.
// There's also an older "customoai" vendor still accepted in that same file
// (distinct from the dead settings.json key above) -- some VS Code builds
// don't render customendpoint's provider grouping / API-key prompt correctly
// (seen on a user's Mac install), so "customoai" is offered as a fallback via
// rennCopilot.providerVendor. Its models never carry an Authorization header
// at request time, so using it also flips the backend to run without proxy
// auth (see setProxyAuthEnabled call in syncModels).
// See https://code.visualstudio.com/docs/agent-customization/language-models
const PROVIDER_NAME = "Renn Copilot";
const API_TYPE = "chat-completions"; // CLIProxyAPI exposes an OpenAI-compatible /v1/chat/completions surface

type ProviderVendor = "customendpoint" | "customoai";

function getProviderVendor(): ProviderVendor {
  const value = vscode.workspace.getConfiguration("rennCopilot").get<string>("providerVendor", "customendpoint");
  return value === "customoai" ? "customoai" : "customendpoint";
}

/**
 * Masks the local part of an email so the full address doesn't show up in
 * the status bar tooltip / quick pick (mirrors dashboard/lib/utils.ts's
 * maskEmail -- kept duplicated here since the extension has no shared lib
 * with the dashboard). Non-email strings pass through unchanged.
 */
function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(3, local.length - visible.length))}${domain}`;
}

interface RemoteModelEntry {
  id: string;
  name: string;
  url: string;
  toolCalling?: boolean;
  vision?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

interface ChatLanguageModelProvider {
  name: string;
  vendor: string;
  apiKey?: string;
  apiType?: string;
  models?: RemoteModelEntry[];
  [key: string]: unknown;
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

export function activate(context: vscode.ExtensionContext) {
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
    void waitForBackendReady(backendUrl).then(() => syncModels(false));
  }

  void refreshHealth();
  healthTimer = setInterval(() => void refreshHealth(), HEALTH_REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });
  context.subscriptions.push({ dispose: () => clearTimeout(healthFastRetryTimer) });
}

export async function deactivate() {
  statusBarItem?.dispose();
  healthStatusBarItem?.dispose();
  clearInterval(healthTimer);
  clearTimeout(healthFastRetryTimer);

  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
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
    void vscode.window.showInformationMessage(
      `Renn Copilot: API key copied to clipboard. Open "Chat: Manage Language Models", pick "${PROVIDER_NAME}", and paste it in.`
    );
  } catch (err: any) {
    void vscode.window.showErrorMessage(`Renn Copilot: couldn't fetch API key (${err.message}). Is the backend running?`);
  }
}

async function syncModels(showNotifications: boolean) {
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
  const vendor = getProviderVendor();

  statusBarItem.text = "$(sync~spin) Renn Copilot";
  try {
    const remote = await fetchJson<{ models: RemoteModelEntry[]; apiKey?: string }>(
      `${backendUrl}/api/models/export`
    );

    // customoai never sends an Authorization header, so the backend has to
    // be told to stop requiring one -- and switching back to customendpoint
    // has to restore it, or chat requests would silently go unauthenticated.
    await putJson(`${backendUrl}/api/server/proxy-auth`, { enabled: vendor !== "customoai" }).catch(() => {
      // Non-fatal -- the backend might not be reachable for this call even
      // though /api/models/export just succeeded (rare race); the model
      // sync below still proceeds either way.
    });

    const { created, changed } = writeProviderEntry(vendor, remote.models, remote.apiKey ?? "");

    statusBarItem.text = `$(check) Renn Copilot (${remote.models.length})`;
    statusBarItem.tooltip = changed
      ? `Synced ${remote.models.length} model(s) into chatLanguageModels.json. Click to re-sync.`
      : `Already up to date (${remote.models.length} model(s)). Click to re-sync.`;

    // A sync round-trip means the backend is reachable -- piggyback a health
    // refresh on it so the dot count doesn't lag behind a manual re-sync.
    void refreshHealth();

    // Only touch the clipboard when the provider entry actually changed --
    // that's exactly the case where VS Code will need the key re-pasted
    // (a brand new entry, or an existing one whose content moved). A no-op
    // sync means the file (and therefore any previously-entered key) is
    // untouched, so overwriting the user's clipboard on every silent
    // startup sync would just be an annoying side effect for no reason.
    // customoai never needs a pasted key at all.
    if (vendor === "customendpoint" && changed && remote.apiKey) {
      await vscode.env.clipboard.writeText(remote.apiKey);
    }

    if (showNotifications) {
      if (!changed) {
        // Nothing actually changed -- don't touch the file (see writeProviderEntry's
        // comment on why) and don't bother the user with a no-op notification.
        return;
      }
      const reload = "Reload Window";
      const keyNote =
        vendor === "customoai"
          ? `No API key needed for this vendor -- the backend now runs without proxy authentication.`
          : remote.apiKey
            ? `The API key was copied to your clipboard -- paste it in with Ctrl+V (Cmd+V on Mac) and press Enter.`
            : `Backend didn't return an API key yet -- run "Renn Copilot: Copy API Key to Clipboard" once it has.`;
      const providerLabel = vendor === "customoai" ? "customoai" : "Custom Endpoint";
      const message = created
        ? `Added "${PROVIDER_NAME}" as a new ${providerLabel} provider with ${remote.models.length} model(s). ` +
          `Reload VS Code, then check the model picker. ${keyNote}`
        : `Synced ${remote.models.length} model(s) into the "${PROVIDER_NAME}" ${providerLabel} provider. ` +
          `Reload VS Code, then check the model picker. ${keyNote}`;
      const choice = await vscode.window.showInformationMessage(message, reload);
      if (choice === reload) {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    } else if (vendor === "customendpoint" && changed && remote.apiKey) {
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
 * Locates User/chatLanguageModels.json for the running VS Code build. This
 * covers the default profile only -- if the user is on a named profile, VS
 * Code stores profile-specific config under User/profiles/<id>/ instead, and
 * this won't find it (not handled here; the user would need to switch to
 * the default profile or this would need extending).
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

  return path.join(base, folderName, "User", "chatLanguageModels.json");
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
function writeProviderEntry(
  vendor: ProviderVendor,
  models: RemoteModelEntry[],
  apiKey: string
): { created: boolean; changed: boolean } {
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

  // Drop any entry left over from the *other* vendor -- switching
  // rennCopilot.providerVendor should replace our entry, not leave a stale
  // duplicate with the old vendor string sitting alongside the new one.
  providers = providers.filter((p) => !(p.name === PROVIDER_NAME && p.vendor !== vendor));

  const entry: ChatLanguageModelProvider =
    vendor === "customoai"
      ? {
          name: PROVIDER_NAME,
          vendor,
          // customoai's models never carry an Authorization header, so the
          // url has to be the base endpoint (CLIProxyAPI appends the path
          // itself), and there's no apiKey/apiType field for this vendor.
          models: models.map((m) => ({ ...m, url: m.url.replace(/\/chat\/completions$/, "") })),
        }
      : {
          name: PROVIDER_NAME,
          vendor,
          apiKey,
          apiType: API_TYPE,
          models,
        };

  const existingIndex = providers.findIndex((p) => p.vendor === vendor && p.name === PROVIDER_NAME);
  const created = existingIndex === -1;
  const existingEntry = created ? null : providers[existingIndex];
  const unchanged = !created && JSON.stringify(existingEntry) === JSON.stringify(entry);
  if (unchanged) {
    return { created: false, changed: false };
  }

  if (created) {
    providers.push(entry);
  } else {
    providers[existingIndex] = entry;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(providers, null, 2), "utf8");
  return { created, changed: true };
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, (res) => {
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
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
