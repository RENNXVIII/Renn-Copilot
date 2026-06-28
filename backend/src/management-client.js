import fetch from "node-fetch";
import { settings, managementBaseUrl } from "./settings.js";
import { loadManagementKeyFromConfig } from "./cliproxy-manager.js";

/**
 * Thin wrapper around CLIProxyAPI's Management API
 * (https://help.router-for.me/management/api.html). We don't reimplement
 * OAuth or config persistence -- CLIProxyAPI already does that; this just
 * forwards requests with the management key attached.
 */
async function call(pathname, { method = "GET", body, query, raw = false } = {}) {
  const key = loadManagementKeyFromConfig() || settings.managementKey;
  const url = new URL(managementBaseUrl() + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  const headers = { Authorization: `Bearer ${key}` };
  if (body && !raw) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text; // e.g. raw YAML from /config.yaml
  }

  if (!res.ok) {
    const message = typeof data === "object" ? data?.error || JSON.stringify(data) : data;
    const err = new Error(`Management API ${method} ${pathname} failed: ${res.status} ${message}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Surgically patches (or inserts) the top-level `routing.strategy` key in raw
// config.yaml text, instead of parsing the whole document with js-yaml and
// re-serializing it -- a full re-dump would silently strip every comment in
// the user's real config.yaml (CLIProxyAPI ships one full of explanatory
// comments). Only ever touches the `strategy:` line inside the `routing:`
// block; everything else in the file is left byte-for-byte untouched.
//
// Confirmed against CLIProxyAPI's authoritative config.example.yaml
// (router-for-me/CLIProxyAPI), which documents exactly:
//   routing:
//     strategy: "round-robin" # round-robin (default), fill-first
//     session-affinity: false
//     session-affinity-ttl: "1h"
export function patchRoutingStrategy(yamlText, strategy) {
  const lines = yamlText.split("\n");
  const routingIdx = lines.findIndex((l) => /^routing:\s*$/.test(l));

  if (routingIdx === -1) {
    const sep = yamlText.endsWith("\n") ? "" : "\n";
    return `${yamlText}${sep}routing:\n  strategy: "${strategy}"\n`;
  }

  // The `routing:` block ends at the next non-blank, non-indented (top-level) line.
  let end = lines.length;
  for (let i = routingIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const strategyLineRe = /^(\s*)strategy:\s*.*$/;
  let found = false;
  for (let i = routingIdx + 1; i < end; i++) {
    if (strategyLineRe.test(lines[i])) {
      lines[i] = lines[i].replace(strategyLineRe, `$1strategy: "${strategy}"`);
      found = true;
      break;
    }
  }
  if (!found) {
    lines.splice(routingIdx + 1, 0, `  strategy: "${strategy}"`);
  }
  return lines.join("\n");
}

// Read-only lookup used just to report the current strategy -- mirrors the
// same line-scanning logic as patchRoutingStrategy so reads and writes always
// agree on where the value lives, and falls back to CLIProxyAPI's documented
// default ("round-robin") when the key isn't present yet.
export function readRoutingStrategy(yamlText) {
  const lines = yamlText.split("\n");
  const routingIdx = lines.findIndex((l) => /^routing:\s*$/.test(l));
  if (routingIdx === -1) return "round-robin";

  let end = lines.length;
  for (let i = routingIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (/^\S/.test(lines[i])) {
      end = i;
      break;
    }
  }

  for (let i = routingIdx + 1; i < end; i++) {
    const match = lines[i].match(/^\s*strategy:\s*["']?([\w-]+)["']?/);
    if (match) return match[1];
  }
  return "round-robin";
}

export const management = {
  // --- Server / config -----------------------------------------------
  getConfig: () => call("/config"),
  getConfigYaml: () => call("/config.yaml", { raw: true }),
  putConfigYaml: (yamlText) =>
    call("/config.yaml", { method: "PUT", body: yamlText, raw: true }),

  // --- Logs ------------------------------------------------------------
  getLogs: (after) => call("/logs", { query: { after } }),
  clearLogs: () => call("/logs", { method: "DELETE" }),

  // --- Auth files (OAuth token storage) --------------------------------
  listAuthFiles: () => call("/auth-files"),
  deleteAuthFile: (name) => call("/auth-files", { method: "DELETE", query: { name } }),
  deleteAllAuthFiles: () => call("/auth-files", { method: "DELETE", query: { all: "true" } }),
  // Toggles the manual "disabled" flag on an auth file -- distinct from
  // "unavailable" (which CLIProxyAPI sets itself on quota/rate-limit). While
  // disabled, the account is excluded from routing/round-robin entirely.
  // `name` accepts either the auth file's name or its auth ID.
  setAuthFileDisabled: (name, disabled) =>
    call("/auth-files/status", { method: "PATCH", body: { name, disabled } }),

  // Per-(provider, base_url|api_key) request buckets for non-OAuth providers
  // (openai-compatibility, plus extra gemini/claude/codex API keys). Mirrors
  // the success/failed/recent_requests shape already returned inline by
  // GET /auth-files for OAuth accounts -- see routes.js's /usage handler,
  // which merges both into one response for the dashboard.
  getApiKeyUsage: () => call("/api-key-usage"),

  // Per-request token usage as reported directly by the upstream provider in
  // each response body (input/output/reasoning/cached/total tokens, latency,
  // model, provider) -- not an estimate CLIProxyAPI computes itself. This is
  // a pop-and-remove queue: every record returned here is deleted from
  // CLIProxyAPI's queue, so callers must persist what they read. See
  // usage-store.js / usage-poller.js, which drain this on an interval and
  // keep our own aggregate.
  getUsageQueue: (count) => call("/usage-queue", { query: { count } }),
  getUsageStatisticsEnabled: () => call("/usage-statistics-enabled"),
  setUsageStatisticsEnabled: (value) =>
    call("/usage-statistics-enabled", { method: "PUT", body: { value } }),

  // --- OAuth login flows ------------------------------------------------
  // Providers exposed directly by the Management API today: anthropic
  // (Claude web/Claude Code), codex (ChatGPT/Codex), antigravity (Google).
  // Gemini CLI / Qwen / iFlow auth currently has to go through the
  // CLIProxyAPI CLI's own --login flags; see cliproxy-manager for the
  // process spawn helpers, and the TODO in routes/providers.js.
  getAnthropicAuthUrl: () => call("/anthropic-auth-url", { query: { is_webui: "true" } }),
  getCodexAuthUrl: () => call("/codex-auth-url", { query: { is_webui: "true" } }),
  getAntigravityAuthUrl: () => call("/antigravity-auth-url", { query: { is_webui: "true" } }),
  getAuthStatus: (state) => call("/get-auth-status", { query: { state } }),

  // --- Provider API keys (non-OAuth providers / extra keys) -------------
  getGeminiApiKeys: () => call("/gemini-api-key"),
  putGeminiApiKeys: (items) => call("/gemini-api-key", { method: "PUT", body: items }),
  getClaudeApiKeys: () => call("/claude-api-key"),
  putClaudeApiKeys: (items) => call("/claude-api-key", { method: "PUT", body: items }),
  getCodexApiKeys: () => call("/codex-api-key"),
  putCodexApiKeys: (items) => call("/codex-api-key", { method: "PUT", body: items }),
  getOpenAiCompatibility: () => call("/openai-compatibility"),
  putOpenAiCompatibility: (items) => call("/openai-compatibility", { method: "PUT", body: items }),

  // --- Misc toggles -------------------------------------------------------
  getDebug: () => call("/debug"),
  setDebug: (value) => call("/debug", { method: "PUT", body: { value } }),
  getRequestLog: () => call("/request-log"),
  setRequestLog: (value) => call("/request-log", { method: "PUT", body: { value } }),
  resetQuota: (authIndex) => call("/reset-quota", { method: "POST", body: { auth_index: authIndex } }),
};
