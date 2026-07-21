import fs from "node:fs";
import express from "express";
import {
    getStatus,
    getRecentLogs,
    installOrUpdateBinary,
    getVersionStatus,
    startServer,
    stopServer,
    restartServer,
    setProxyAuthEnabled,
    startXaiLogin,
    getXaiLoginStatus,
} from "./cliproxy-manager.js";
import { management, patchRoutingStrategy, readRoutingStrategy } from "./management-client.js";
import { listLiveModelIds, probeVisionSupport } from "./proxy-client.js";
import {
    buildModelList,
    mergeEnabledModels,
    migrateLegacyVisionCapability,
    modelCapabilityKey,
    resolveVisionCapability,
    toCopilotModelEntry,
} from "./model-catalog.js";
import { readState, writeState } from "./state.js";
import { settings, proxyBaseUrl } from "./settings.js";
import { getUsageSummary, getUsageByCredential, getUsageByCredentialWindows } from "./usage-store.js";
import { getCodexUsage } from "./codex-usage.js";
import { proxyChatCompletions } from "./chat-proxy.js";

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
router.get("/server/status", asyncHandler(async (req, res) => res.json({ ...getStatus(), ...(await getVersionStatus()) })));

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

// Lets the extension flip whether CLIProxyAPI requires the proxy API key at
// all -- needed for VS Code's "customoai" BYOK vendor, which never sends an
// Authorization header (see setProxyAuthEnabled's doc comment).
router.put(
    "/server/proxy-auth",
    express.json(),
    asyncHandler(async (req, res) => {
        const enabled = req.body?.enabled !== false;
        res.json({ ok: true, enabled, ...setProxyAuthEnabled(enabled) });
    })
);

// Sanitizing hop in front of CLIProxyAPI's own /v1/chat/completions, used
// only for Claude-family models (see chat-proxy.js and toCopilotModelEntry
// in model-catalog.js for why -- Anthropic rejects top_p/temperature/top_k
// on Claude Opus 4.7+/Sonnet 4.5+, which VS Code still sends by default).
router.post("/proxy/v1/chat/completions", express.json({ limit: "25mb" }), asyncHandler(proxyChatCompletions));

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

// GET /auth-files' response doesn't include each credential's `prefix`
// (confirmed empirically -- the field is stored and applied for routing, but
// not surfaced in this listing), so we read it directly off the auth file on
// disk (same pattern as codex-usage.js/antigravity-usage.js) and merge it in.
function readPrefixFromDisk(filePath) {
    if (!filePath) return "";
    try {
        const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
        return typeof doc.prefix === "string" ? doc.prefix : "";
    } catch {
        return "";
    }
}

router.get(
    "/auth-files",
    asyncHandler(async (req, res) => {
        const raw = await management.listAuthFiles();
        const files = Array.isArray(raw?.files) ? raw.files : normalizeList(raw);
        const withPrefix = files.map((f) => ({ ...f, prefix: readPrefixFromDisk(f.path) }));
        res.json(Array.isArray(raw?.files) ? { ...raw, files: withPrefix } : withPrefix);
    })
);

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

// Namespaces a credential's models as "<prefix>/<model-id>" -- see
// management-client.js's setAuthFilePrefix doc comment for why this exists:
// it's the only way to address one specific credential when two providers
// (or two credentials of the same provider) serve the identical bare model
// id, since CLIProxyAPI otherwise pools every credential serving that id
// into one round-robin/fill-first group. Pass prefix: "" to clear it.
router.patch(
    "/auth-files/prefix",
    express.json(),
    asyncHandler(async (req, res) => {
        const { name, prefix } = req.body || {};
        if (!name || typeof prefix !== "string") {
            return res.status(400).json({ error: "Body must include { name: string, prefix: string }" });
        }
        if (!/^[a-zA-Z0-9_-]*$/.test(prefix)) {
            return res.status(400).json({ error: "Prefix may only contain letters, numbers, hyphens, and underscores" });
        }
        res.json(await management.setAuthFilePrefix(name, prefix));
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

const ZERO_CRED_STATS = { requests: 0, failed: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, total_tokens: 0 };

// Per-credential usage table (request/token/cache-rate totals joined with
// live rate-limit quota) for the Usage page's "Auth Files" view -- inspired
// by cpa-usage-keeper's dashboard, adapted to reuse the usage-queue data
// this backend already has instead of requiring Redis (see usage-store.js's
// getUsageByCredential/getUsageByCredentialWindows). Only Codex gets a live
// quota (see codex-usage.js) -- Antigravity's equivalent was removed: its
// only real quota data is Gemini-only (no 5h/weekly split to match this
// shape), and there's no legitimate remote API for its Claude/GPT usage
// (the only way to get that requires spoofing a client identity to Google,
// which risks the account being flagged -- not worth it for this feature).
router.get(
    "/usage/credentials",
    asyncHandler(async (req, res) => {
        const authFilesRaw = await management.listAuthFiles();
        const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
        const totalsByAuth = getUsageByCredential({ days: 14 });
        const windowsByAuth = getUsageByCredentialWindows();

        const credentials = await Promise.all(
            files.map(async (f) => {
                const authIndex = f.auth_index !== undefined && f.auth_index !== null ? String(f.auth_index) : null;
                const totals = (authIndex && totalsByAuth[authIndex]) || ZERO_CRED_STATS;
                const windows = (authIndex && windowsByAuth[authIndex]) || { window5h: ZERO_CRED_STATS, window7d: ZERO_CRED_STATS };
                const cacheRate = totals.input_tokens > 0 ? Math.round((totals.cached_tokens / totals.input_tokens) * 100) : 0;

                const quota = f.provider === "codex" && f.name && f.path ? await getCodexUsage(f.name, f.path) : null;

                return {
                    name: f.name,
                    label: f.label || f.email || f.name,
                    provider: f.provider,
                    disabled: !!f.disabled,
                    unavailable: !!f.unavailable,
                    requests: totals.requests,
                    failedRequests: totals.failed,
                    totalTokens: totals.total_tokens,
                    cacheRate,
                    window5hTokens: windows.window5h.total_tokens,
                    window7dTokens: windows.window7d.total_tokens,
                    quota,
                };
            })
        );
        res.json({ credentials });
    })
);

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
        // xAI has no Management API OAuth endpoint (see cliproxy-manager.js's
        // startXaiLogin doc comment) -- it goes through a standalone CLI login
        // process instead of the Management API flow every other provider uses,
        // but returns the same { status, url, state } shape so the dashboard's
        // existing startLogin/pollLogin flow doesn't need special-casing.
        if (req.params.provider === "xai") {
            const { url, state, userCode } = await startXaiLogin();
            return res.json({ status: "ok", url, state: `xai:${state}`, userCode });
        }

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
    asyncHandler(async (req, res) => {
        const state = req.query.state || "";
        // xAI login states are namespaced with an "xai:" prefix (see above) so
        // this route can tell them apart from Management-API-issued OAuth states
        // without a separate polling endpoint for the dashboard to call.
        if (state.startsWith("xai:")) {
            return res.json(getXaiLoginStatus(state.slice(4)));
        }
        res.json(await management.getAuthStatus(state));
    })
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

// Maps each credential's `prefix` (see /auth-files/prefix, management-client.js's
// setAuthFilePrefix doc comment) to its real provider, so buildModelList can
// resolve a prefixed live id like "claude/claude-sonnet-4-6" to the exact
// credential that owns it -- CLIProxyAPI's Management API doesn't surface
// `prefix` in GET /auth-files, so this reads each auth file directly (same
// pattern as the /auth-files route's readPrefixFromDisk).
async function getPrefixIndex() {
    try {
        const authFilesRaw = await management.listAuthFiles();
        const files = Array.isArray(authFilesRaw?.files) ? authFilesRaw.files : normalizeList(authFilesRaw);
        const index = {};
        for (const f of files) {
            const prefix = readPrefixFromDisk(f.path);
            if (prefix) index[prefix] = f.provider;
        }
        return index;
    } catch {
        return {};
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

// In-process only -- coalesces explicit verify requests for the same scoped
// model. GET /models never probes: polling the dashboard must remain free of
// quota-consuming side effects.
const visionProbeInFlight = new Map();

async function getMergedCatalog() {
    const [loggedInProviders, openAiCompatEntries, prefixIndex] = await Promise.all([
        getLoggedInProviders(),
        getOpenAiCompatEntries(),
        getPrefixIndex(),
    ]);
    try {
        const liveIds = await listLiveModelIds();
        const memory = readState().modelProviderMemory;
        const { models, memory: nextMemory } = buildModelList(liveIds, loggedInProviders, openAiCompatEntries, memory, prefixIndex);
        // Only hits disk when a new id was actually learned (i.e. exactly one
        // provider was logged in and we saw an id we hadn't seen before).
        if (JSON.stringify(nextMemory) !== JSON.stringify(memory)) {
            writeState({ modelProviderMemory: nextMemory });
        }
        return {
            catalog: models,
            source: liveIds.length ? "live" : "empty",
            liveError: null,
            prefixIndex,
        };
    } catch (err) {
        return { catalog: [], source: "empty", liveError: err.message, prefixIndex };
    }
}

// Strips a live id's prefix segment (see /auth-files/prefix) back down to the
// underlying model name, e.g. "claude/claude-sonnet-4-6" -> "claude-sonnet-4-6".
// Only ever strips when the segment before "/" is a real, currently-set
// credential prefix -- a customProvider or catalog id's own "/" (e.g. an
// OpenRouter-style "meta-llama/llama-3.1-70b") is left untouched.
function basePartOf(id, prefixIndex) {
    const slash = id.indexOf("/");
    if (slash > 0 && prefixIndex[id.slice(0, slash)]) return id.slice(slash + 1);
    return id;
}

function capabilityKeyFor(model, prefixIndex) {
    // A prefixed id identifies one concrete credential route. Keep the full id
    // so two credentials from the same provider exposing the same base model
    // can have independent evidence and overrides.
    return modelCapabilityKey(model);
}

function storedCapabilityFor(model, state, prefixIndex) {
    const capabilities = readState().modelCapabilities || state.modelCapabilities || {};
    const key = capabilityKeyFor(model, prefixIndex);
    if (capabilities[key]) return capabilities[key];

    // Best-effort migration for state written before capabilities were scoped
    // by provider. The old implementation keyed by the full model id, so do
    // not fall back from a credential-prefixed id to its bare model name: that
    // could copy evidence from one credential into every other credential
    // exposing the same underlying model.
    const legacy = capabilities[model.id];
    if (!legacy) return undefined;
    const migrated = migrateLegacyVisionCapability(legacy);
    const latest = readState().modelCapabilities || {};
    writeState({ modelCapabilities: { ...latest, [key]: migrated } });
    return migrated;
}

async function probeAndStoreVision(model, prefixIndex) {
    const key = capabilityKeyFor(model, prefixIndex);
    if (visionProbeInFlight.has(key)) return visionProbeInFlight.get(key);

    const pending = probeVisionSupport(model.id)
        .then((result) => {
            const current = readState().modelCapabilities || {};
            const capability = { ...result, source: "probe", checkedAt: Date.now() };
            const stored = { ...(current[key] || {}), probe: capability };
            writeState({ modelCapabilities: { ...current, [key]: stored } });
            return capability;
        })
        .catch((err) => {
            if (!err.inconclusive) throw err;
            const current = readState().modelCapabilities || {};
            const capability = { vision: "unknown", source: "probe", note: err.message, checkedAt: Date.now() };
            const stored = { ...(current[key] || {}), probe: capability };
            writeState({ modelCapabilities: { ...current, [key]: stored } });
            return capability;
        })
        .finally(() => visionProbeInFlight.delete(key));

    visionProbeInFlight.set(key, pending);
    return pending;
}

router.get(
    "/models",
    asyncHandler(async (req, res) => {
        const state = readState();
        const { catalog, source, liveError, prefixIndex } = await getMergedCatalog();

        const models = catalog.map((m) => {
            return {
                ...m,
                enabled: state.enabledModelIds.includes(m.id),
                capabilities: resolveVisionCapability(m, storedCapabilityFor(m, state, prefixIndex)),
            };
        });
        res.json({ models, source, liveError });
    })
);

// Manually (re-)probes one model's vision support, bypassing the "only ever
// probed once" rule that GET /models follows automatically -- used by the
// dashboard's "Re-check" action when a cached result looks stale or wrong.
// This is a real request against a live account, so unlike the auto-probe it
// runs synchronously and the caller waits for the actual result.
router.post(
    "/models/:id/verify-vision",
    asyncHandler(async (req, res) => {
        const modelId = req.params.id;
        const { catalog, prefixIndex } = await getMergedCatalog();
        const model = catalog.find((item) => item.id === modelId);
        if (!model) return res.status(404).json({ error: `Model "${modelId}" is not currently available.` });
        const result = await probeAndStoreVision(model, prefixIndex);
        res.status(result.vision === "unknown" ? 409 : 200).json({ modelId, ...result, inconclusive: result.vision === "unknown" });
    })
);

router.patch(
    "/models/:id/vision",
    express.json(),
    asyncHandler(async (req, res) => {
        const modelId = req.params.id;
        const vision = req.body?.vision;
        if (![true, false, "auto"].includes(vision)) {
            return res.status(400).json({ error: "Body must include { vision: true | false | \"auto\" }." });
        }

        const { catalog, prefixIndex } = await getMergedCatalog();
        const model = catalog.find((item) => item.id === modelId);
        if (!model) return res.status(404).json({ error: `Model "${modelId}" is not currently available.` });

        const current = { ...(readState().modelCapabilities || {}) };
        const key = capabilityKeyFor(model, prefixIndex);
        if (vision === "auto") {
            const existing = current[key];
            if (existing?.probe && existing.probe.source !== "manual") current[key] = { probe: existing.probe };
            else delete current[key];
            // Remove the matching pre-scoping entry too, otherwise the lazy
            // migration path would immediately restore it on the next GET.
            delete current[model.id];
        } else {
            const existing = current[key] || {};
            current[key] = { ...existing, override: vision, overrideAt: Date.now() };
        }
        writeState({ modelCapabilities: current });
        res.json({ modelId, capabilities: resolveVisionCapability(model, current[key]) });
    })
);

router.put(
    "/models",
    express.json(),
    asyncHandler(async (req, res) => {
        const enabledModelIds = Array.isArray(req.body?.enabledModelIds) ? req.body.enabledModelIds : [];
        const previousState = readState();
        const previousIds = new Set(previousState.enabledModelIds);
        // Enabling a text model must never fail merely because the optional
        // vision probe is unavailable. Persist the user's choice immediately;
        // all capability checks below are best-effort enrichment only.
        const state = writeState({ enabledModelIds });
        const { catalog, prefixIndex } = await getMergedCatalog();
        const newlyEnabled = catalog.filter((model) => enabledModelIds.includes(model.id) && !previousIds.has(model.id));

        const modelProviderMemory = { ...(readState().modelProviderMemory || {}) };
        for (const model of catalog) {
            if (enabledModelIds.includes(model.id)) modelProviderMemory[model.id] = model.provider;
        }
        writeState({ modelProviderMemory });

        // Enabling is an explicit user action, unlike polling. Verify only newly
        // enabled models whose capability is still genuinely unknown. Bulk enable
        // may perform several small requests, each coalesced and persisted.
        const probeConcurrency = 3;
        for (let offset = 0; offset < newlyEnabled.length; offset += probeConcurrency) {
            const batch = newlyEnabled.slice(offset, offset + probeConcurrency);
            await Promise.allSettled(batch.map(async (model) => {
                const capability = resolveVisionCapability(model, storedCapabilityFor(model, previousState, prefixIndex));
                if (capability.vision === "unknown") await probeAndStoreVision(model, prefixIndex);
            }));
        }
        res.json({ ok: true, enabledModelIds: state.enabledModelIds });
    })
);

router.get(
    "/models/export",
    asyncHandler(async (req, res) => {
        const state = readState();
        const { catalog, prefixIndex } = await getMergedCatalog();
        // Export every model the user explicitly enabled, even if the live
        // catalog is temporarily missing it during startup or account recovery.
        // This keeps the extension's Renn Copilot group stable across reloads.
        const enabled = mergeEnabledModels(catalog, state.enabledModelIds, state.modelProviderMemory);
        const entries = enabled.map((m) =>
            toCopilotModelEntry(
                { ...m, capabilities: resolveVisionCapability(m, storedCapabilityFor(m, state, prefixIndex)) },
                { proxyUrl: proxyBaseUrl(), ownBaseUrl: `http://127.0.0.1:${settings.port}` }
            )
        );
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

// xAI has no dedicated Management API key list (confirmed against
// help.router-for.me/management/api.html -- unlike gemini/claude/codex-key
// below, there's no /xai-api-key endpoint at all). Its API is OpenAI-
// compatible, so this reads/writes one openai-compatibility entry pinned to
// api.x.ai instead, presenting it to the dashboard as a single { item }
// (not a list) since xAI only ever needs the one shared entry -- multiple
// raw keys can still round-robin inside its api-key-entries array.
const XAI_BASE_URL = "https://api.x.ai/v1";

async function findXaiEntry() {
    const items = normalizeList(await management.getOpenAiCompatibility());
    return items.find((e) => e["base-url"] === XAI_BASE_URL) || null;
}

router.get(
    "/api-providers/xai-key",
    asyncHandler(async (req, res) => res.json({ item: await findXaiEntry() }))
);
router.put(
    "/api-providers/xai-key",
    express.json(),
    asyncHandler(async (req, res) => {
        const incoming = req.body?.item;
        const items = normalizeList(await management.getOpenAiCompatibility());
        const idx = items.findIndex((e) => e["base-url"] === XAI_BASE_URL);

        if (!incoming || !incoming["api-key-entries"]?.length) {
            if (idx !== -1) items.splice(idx, 1);
        } else {
            const entry = { ...incoming, name: "xai", "base-url": XAI_BASE_URL };
            if (idx === -1) items.push(entry);
            else items[idx] = entry;
        }

        await management.putOpenAiCompatibility(items);
        res.json({ item: await findXaiEntry() });
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

// --- Preferences --------------------------------------------------------
// Global dashboard/extension preferences. revealEmails is read by both the
// webview (every row with an email) and the VS Code status bar/tooltip.
// claudeCoworkMode is provider-level (Claude only) and is consumed by the
// chat-proxy hop when forwarding Claude models to CLIProxyAPI.
router.get("/preferences", (req, res) => {
    const state = readState();
    res.json({
        revealEmails: Boolean(state.revealEmails),
        claudeCoworkMode: Boolean(state.claudeCoworkMode),
    });
});
router.put("/preferences", express.json(), (req, res) => {
    const current = readState();
    const partial = {};
    // Partial updates: only overwrite fields the client actually sent so
    // useEmailReveal (which only knows about revealEmails) cannot clobber
    // claudeCoworkMode, and vice versa.
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "revealEmails")) {
        partial.revealEmails = Boolean(req.body.revealEmails);
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "claudeCoworkMode")) {
        partial.claudeCoworkMode = Boolean(req.body.claudeCoworkMode);
    }
    const state = Object.keys(partial).length ? writeState(partial) : current;
    res.json({
        revealEmails: Boolean(state.revealEmails),
        claudeCoworkMode: Boolean(state.claudeCoworkMode),
    });
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
