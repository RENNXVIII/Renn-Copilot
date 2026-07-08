import fs from "node:fs";
import fetch from "node-fetch";

// ChatGPT's own (undocumented, reverse-engineered) rate-limit check --
// costs no model quota, but the URL/shape could change without notice since
// it's not a public API. Cached per account so multiple webview instances
// (editor tab + sidebar) polling in parallel don't multiply the request rate
// against it.
const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // auth file name -> { at, result }

async function fetchWhamUsage(accessToken, accountId) {
  const res = await fetch(WHAM_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://chatgpt.com",
      Referer: "https://chatgpt.com/",
    },
  });
  if (!res.ok) {
    const err = new Error(`wham/usage failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function toWindow(window) {
  if (!window) return null;
  return {
    usedPercent: window.used_percent ?? null,
    windowSeconds: window.limit_window_seconds ?? null,
    resetAfterSeconds: window.reset_after_seconds ?? null,
  };
}

/**
 * Fetches ChatGPT's rate-limit usage for one codex auth file. access_token
 * and account_id live directly in the file CLIProxyAPI already wrote to
 * disk (see cliproxy-manager.js's auth-dir) -- read-only here, this never
 * writes to that file. A 401 (expired access_token) is reported as
 * `{ ok: false }` rather than thrown: CLIProxyAPI refreshes these tokens on
 * its own schedule, so the right move is to wait for that, not to attempt a
 * refresh ourselves and risk racing CLIProxyAPI's own refresh cycle.
 */
export async function getCodexUsage(name, filePath) {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  let result;
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const accessToken = doc.access_token;
    const accountId = doc.account_id;
    if (!accessToken || !accountId) {
      result = { ok: false, reason: "auth file missing access_token/account_id" };
    } else {
      const data = await fetchWhamUsage(accessToken, accountId);
      result = {
        ok: true,
        planType: data.plan_type ?? null,
        primary: toWindow(data.rate_limit?.primary_window),
        secondary: toWindow(data.rate_limit?.secondary_window),
      };
    }
  } catch (err) {
    result = { ok: false, reason: err.status === 401 ? "token expired, waiting for refresh" : err.message };
  }

  cache.set(name, { at: Date.now(), result });
  return result;
}
