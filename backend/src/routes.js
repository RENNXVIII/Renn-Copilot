import express from "express";
import {
  getStatus,
  getRecentLogs,
  installOrUpdateBinary,
  startServer,
  stopServer,
  restartServer,
} from "./cliproxy-manager.js";
import { management, patchRoutingStrategy, readRoutingStrategy } from "./management-client.js";
import { listLiveModelIds } from "./proxy-client.js";
import {
  getExtensionStatus,
  getExtensionLogs,
  compileExtension,
  packageExtension,
  installExtension,
} from "./extension-manager.js";
import { buildModelList, toCopilotModelEntry } from "./model-catalog.js";
import { readState, writeState } from "./state.js";
import { settings, proxyBaseUrl } from "./settings.js";
import { getUsageSummary } from "./usage-store.js";

export const router = express.Router();

// CLIProxyAPI's GET for these list endpoints doesn't consistently document
// whether it returns a bare array or an object wrapping one -- normalize
// either shape into a plain array so the dashboard always gets the same
// { items: [...] } envelope regardless of upstream's exact response shape.
function normalizeList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const arr = Object.values(raw).find((v) => Array.isArray(v));
    if (arr) return arr;
  }
  return [];
}

function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  });
}

// --- Server lifecycle -----------------------------------------------------
router.get("/server/status", (req, res) => res.json(getStatus()));

router.post(
  "/server/install",
  asyncHandler(async (req, res) => {
    const version = await installOrUpdateBinary();
    res.json({ ok: true, version });
  })
);

router.post("/server/start", asyncHandler(async (req, res) => res.json(await startServer())));
router.post("/server/stop", asyncHandler(async (req, res) => res.json(await stopServer())));
router.post("/server/restart", asyncHandler(async (req, res) => res.json(await restartServer())));

router.get("/server/logs", (req, res) => res.json({ lines: getRecentLogs() }));

// --- Config (proxied to CLIProxyAPI's Management API) ---------------------
router.get("/config", asyncHandler(async (req, res) => res.json(await management.getConfig())));

router.get(
  "/config.yaml",
  asyncHandler(async (req, res) => {
    const yamlText = await management.getConfigYaml();
    res.type("text/plain").send(yamlText);
  })
);

router.put(
  "/config.yaml",
  express.text({ type: "*/*" }),
  asyncHandler(async (req, res) => res.json(await management.putConfigYaml(req.body)))
);

// Routing strategy CLIProxyAPI uses when multiple credentials match a
// request -- "round-robin" (default) or "fill-first". There's no dedicated
// Management API endpoint for this, so it's read/written through the same
// raw config.yaml the Config page already edits, surgically patching just
// the `routing.strategy` line (see patchRoutingStrategy) instead of
// re-serializing the whole file and losing the user's comments.
const ROUTING_STRATEGIES = ["round-robin", "fill-first"];

router.get(
  "/routing-strategy",
  asyncHandler(async (req, res) => {
    const yamlText = await management.getConfigYaml();
    res.json({ strategy: readRoutingStrategy(yamlText) });
  })
);

router.put(
  "/routing-strategy",
  express.json(),
  asyncHandler(async (req, res) => {
    const { strategy } = req.body || {};
    if (!ROUTING_STRATEGIES.includes(strategy)) {
      return res.status(400).json({ error: `Body must include { strategy: "round-robin" | "fill-first" }` });
    }
    const current = await management.getConfigYaml();
    const patched = patchRoutingStrategy(current, strategy);
    await management.putConfigYaml(patched);
    res.json({ strategy });
  })
);

// --- Logs from CLIProxyAPI itself (separate from our own process logs) ----
router.get(
  "/proxy-logs",
  asyncHandler(async (req, res) => res.json(await management.getLogs(req.query.after)))
);

// --- Auth files (OAuth credential management) ------------------------------
router.get("/auth-files", asyncHandler(async (req, res) => res.json(await management.listAuthFiles())));

router.delete(
  "/auth-files/:name",
  asyncHandler(async (req, res) => res.json(await management.deleteAuthFile(req.params.name)))
);

// Active/inactive switch: disabled=true takes the credential out of CLIProxyAPI's
// routing/round-robin without deleting its stored token, so it can be flipped
// back on later without re-logging in.
router.patch(
  "/auth-files/status",
  express.json(),
  asyncHandler(async (req, res) => {
    const { name, disabled } = req.body || {};
    if (!name || typeof disabled !== "boolean") {
      return res.status(400).json({ error: "Body must include { name: string, disabled: boolean }" });
    }
    res.json(await management.setAuthFileDisabled(name, disabled));
  })
);

// Manually clears CLIProxyAPI's own quota/cooldown tracking for one account.
// `authIndex` is the stable runtime id from GET /auth-files (not the file name).
router.post(
  "/auth-files/reset-quota",
  express.json(),
  asyncHandler(async (req, res) => {
    const { authIndex } = req.body || {};
    if (!authIndex) {
      return res.status(400).json({ error: "Body must include { authIndex: string }" });
    }
    res.json(await management.resetQuota(authIndex));
  })
);

// Masks an API key for display, keeping just enough on each end to recognize
// which key is which without exposing the secret in the dashboard's network
// tab / React devtools.
function maskKey(key) {
  if (!key) return "";
  if (key.length <= 7) return "***";
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

// Merges the two usage data sources CLIProxyAPI exposes:
//  - GET /auth-files: per-OAuth-account cumulative success/failed counters
//    plus a 20-bucket (10 min each) recent_requests timeline -- already
//    fetched for the Providers page, just re-shaped here.
//  - GET /api-key-usage: the same success/failed/recent_requests shape, but
//    keyed by provider + "base_url|api_key" for non-OAuth providers
//    (openai-compatibility, plus extra gemini/claude/codex API keys).
// Wrapped in one response so the dashboard's Usage page makes a single call.
router.get(
  "/usage",
  asyncHandler(async (req, res) => {
    const [authFilesRaw, apiKeyUsageRaw, openAiCompatEntries] = await Promise.all([
      management.listAuthFiles(),
      // Older CLIProxyAPI builds may not have this endpoint yet -- degrade
      // to "no api-key usage data" rather than failing the whole page.
      management.getApiKeyUsage().catch(() => ({})),
      getOpenAiCompatEntries(),
    ]);

    const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
    const accounts = files.map((f) => ({
      name: f.name,
      label: f.label || f.email || f.name,
      provider: f.provider,
      disabled: !!f.disabled,
      unavailable: !!f.unavailable,
      success: f.success ?? 0,
      failed: f.failed ?? 0,
      recent_requests: f.recent_requests ?? [],
      // When unavailable=true, CLIProxyAPI may set this to when it expects
      // the quota/rate-limit to clear. Format varies by CLIProxyAPI version
      // (seen as either a unix timestamp or an ISO string) -- the dashboard
      // does best-effort parsing rather than assuming one format.
      next_retry_after: f.next_retry_after ?? null,
    }));

    // GET /api-key-usage only gives us "base_url|api_key" -- no human name.
    // For custom (openai-compatibility) providers we do have one: the entry's
    // own `name` field, matched here by base URL so the dashboard/extension
    // can show e.g. "minimax-m3" instead of a masked key like "sk-...Pzn4".
    const nameByBaseUrl = new Map(
      openAiCompatEntries.filter((e) => e?.name && e["base-url"]).map((e) => [e["base-url"], e.name])
    );

    const apiKeys = [];
    for (const [provider, keyed] of Object.entries(apiKeyUsageRaw || {})) {
      if (!keyed || typeof keyed !== "object") continue;
      for (const [composite, stats] of Object.entries(keyed)) {
        const sep = composite.indexOf("|");
        const baseUrl = sep === -1 ? "" : composite.slice(0, sep);
        const rawKey = sep === -1 ? composite : composite.slice(sep + 1);
        apiKeys.push({
          provider,
          name: (baseUrl && nameByBaseUrl.get(baseUrl)) || null,
          baseUrl: baseUrl || null,
          keyMasked: maskKey(rawKey),
          success: stats?.success ?? 0,
          failed: stats?.failed ?? 0,
          recent_requests: stats?.recent_requests ?? [],
        });
      }
    }

    const totals = [...accounts, ...apiKeys].reduce(
      (acc, x) => ({ success: acc.success + (x.success || 0), failed: acc.failed + (x.failed || 0) }),
      { success: 0, failed: 0 }
    );

    res.json({ accounts, apiKeys, totals });
  })
);

// Token-level usage as reported directly by the provider in each response
// body (input/output/total tokens, etc.) -- drained from CLIProxyAPI's
// pop-and-remove GET /usage-queue by usage-poller.js and persisted in
// usage-store.js, since that endpoint deletes records the moment anyone
// reads them. `days` controls how many of our own stored daily buckets to
// sum over (default 7); it does not change what CLIProxyAPI itself retains.
router.get("/usage/tokens", (req, res) => {
  const days = Number(req.query.days) || 7;
  res.json(getUsageSummary({ days }));
});

// --- OAuth login flows ------------------------------------------------------
// Supported directly by CLIProxyAPI's Management API today.
const LOGIN_HANDLERS = {
  antigravity: management.getAntigravityAuthUrl,
  claude: management.getAnthropicAuthUrl,
  codex: management.getCodexAuthUrl,
};

router.get(
  "/providers/:provider/login",
  asyncHandler(async (req, res) => {
    const handler = LOGIN_HANDLERS[req.params.provider];
    if (!handler) {
      return res.status(400).json({
        error: `No OAuth login endpoint for "${req.params.provider}". ` +
          `Gemini CLI / Qwen / iFlow currently require running the CLIProxyAPI CLI's ` +
          `own --login flow manually (see README "Known limitations").`,
      });
    }
    res.json(await handler());
  })
);

router.get(
  "/providers/login-status",
  asyncHandler(async (req, res) => res.json(await management.getAuthStatus(req.query.state)))
);

// --- Model catalog + BYOK sync for the VS Code extension --------------------
// The extension polls /models/export and writes the result into
// github.copilot.chat.customOAIModels itself (see extension/src/extension.ts) --
// this backend never touches VS Code's settings.json directly.
//
// Model list is fetched live from CLIProxyAPI's GET /v1/models (the real,
// currently-supported set for whatever accounts are logged in) and merged
// with the static MODEL_CATALOG for nicer labels. If the live call fails
// (server not running yet, no accounts logged in, proxy key not ready),
// we fall back to the static catalog so the page still renders something.
async function getLoggedInProviders() {
  try {
    const authFilesRaw = await management.listAuthFiles();
    const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
    return Array.from(new Set(files.map((f) => f.provider).filter(Boolean)));
  } catch {
    // If auth-files can't be read, fall back to name-based guessing in buildModelList.
    return [];
  }
}

async function getOpenAiCompatEntries() {
  try {
    return normalizeList(await management.getOpenAiCompatibility());
  } catch {
    // Custom-provider lookup is best-effort -- if it fails, ids just fall
    // back to guessProvider() like before.
    return [];
  }
}

async function getMergedCatalog() {
  const [loggedInProviders, openAiCompatEntries] = await Promise.all([
    getLoggedInProviders(),
    getOpenAiCompatEntries(),
  ]);
  try {
    const liveIds = await listLiveModelIds();
    const memory = readState().modelProviderMemory;
    const { models, memory: nextMemory } = buildModelList(liveIds, loggedInProviders, openAiCompatEntries, memory);
    // Only hits disk when a new id was actually learned (i.e. exactly one
    // provider was logged in and we saw an id we hadn't seen before).
    if (JSON.stringify(nextMemory) !== JSON.stringify(memory)) {
      writeState({ modelProviderMemory: nextMemory });
    }
    return {
      catalog: models,
      source: liveIds.length ? "live" : "empty",
      liveError: null,
    };
  } catch (err) {
    return { catalog: [], source: "empty", liveError: err.message };
  }
}

router.get(
  "/models",
  asyncHandler(async (req, res) => {
    const state = readState();
    const { catalog, source, liveError } = await getMergedCatalog();
    const models = catalog.map((m) => ({ ...m, enabled: state.enabledModelIds.includes(m.id) }));
    res.json({ models, source, liveError });
  })
);

router.put("/models", express.json(), (req, res) => {
  const enabledModelIds = Array.isArray(req.body?.enabledModelIds) ? req.body.enabledModelIds : [];
  const state = writeState({ enabledModelIds });
  res.json({ ok: true, enabledModelIds: state.enabledModelIds });
});

router.get(
  "/models/export",
  asyncHandler(async (req, res) => {
    const state = readState();
    const { catalog } = await getMergedCatalog();
    const enabled = catalog.filter((m) => state.enabledModelIds.includes(m.id));
    const entries = enabled.map((m) => toCopilotModelEntry(m, { proxyUrl: proxyBaseUrl() }));
    // VS Code's current BYOK mechanism ("Custom Endpoint" provider, written to
    // chatLanguageModels.json) keys the API key at the *provider* level, not
    // per-model -- so the extension needs CLIProxyAPI's proxy key alongside
    // the model list to assemble that provider entry itself.
    res.json({ models: entries, apiKey: settings.proxyApiKey });
  })
);

// --- Custom API-key providers (GLM, Kimi, or any OpenAI-compatible endpoint,
// plus extra Gemini/Claude/Codex API keys alongside OAuth logins) -----------
// CLIProxyAPI's PUT here replaces the *entire* array, so the dashboard always
// sends back the full desired list (read full list, edit client-side, PUT
// whole list) rather than diffing single entries server-side.
router.get(
  "/api-providers/openai-compat",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getOpenAiCompatibility()) }))
);
router.put(
  "/api-providers/openai-compat",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putOpenAiCompatibility(items)) });
  })
);

router.get(
  "/api-providers/gemini-key",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getGeminiApiKeys()) }))
);
router.put(
  "/api-providers/gemini-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putGeminiApiKeys(items)) });
  })
);

router.get(
  "/api-providers/claude-key",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getClaudeApiKeys()) }))
);
router.put(
  "/api-providers/claude-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putClaudeApiKeys(items)) });
  })
);

router.get(
  "/api-providers/codex-key",
  asyncHandler(async (req, res) => res.json({ items: normalizeList(await management.getCodexApiKeys()) }))
);
router.put(
  "/api-providers/codex-key",
  express.json(),
  asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json({ items: normalizeList(await management.putCodexApiKeys(items)) });
  })
);

// --- VS Code extension build/package (so a separate terminal is never needed) ----
// Spawns the same `npm run compile` / `npm run package` you'd otherwise run by hand
// inside extension/, streaming their output into a log buffer the dashboard polls.
router.get("/extension/status", (req, res) => res.json(getExtensionStatus()));
router.get("/extension/logs", (req, res) => res.json({ lines: getExtensionLogs() }));

router.post(
  "/extension/compile",
  asyncHandler(async (req, res) => res.json(await compileExtension()))
);

router.post(
  "/extension/package",
  asyncHandler(async (req, res) => res.json(await packageExtension()))
);

router.post(
  "/extension/install",
  express.json(),
  asyncHandler(async (req, res) => res.json(await installExtension(req.body?.vsixPath)))
);

// --- Preferences --------------------------------------------------------
// Currently just the one global "show full emails vs. masked" switch, read by
// both the dashboard (every row with an email) and the VS Code extension's
// status bar/tooltip, so toggling it in one place updates both.
router.get("/preferences", (req, res) => res.json({ revealEmails: readState().revealEmails }));
router.put("/preferences", express.json(), (req, res) => {
  const revealEmails = Boolean(req.body?.revealEmails);
  const state = writeState({ revealEmails });
  res.json({ revealEmails: state.revealEmails });
});

// --- Misc -------------------------------------------------------------------
router.get("/settings", (req, res) =>
  res.json({
    cliproxyHome: settings.cliproxyHome,
    cliproxyPort: settings.cliproxyPort,
    cliproxyHost: settings.cliproxyHost,
    proxyBaseUrl: proxyBaseUrl(),
  })
);
