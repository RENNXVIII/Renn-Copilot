import fs from "node:fs";
import fetch from "node-fetch";

// Google's real Cloud Code Assist quota-check API (the same host/auth
// CLIProxyAPI itself uses for Antigravity chat requests -- confirmed via
// CLIProxyAPI's own source, not reverse-engineered). Unlike Codex's
// wham/usage, this is scoped to Gemini model quota only: Antigravity's
// Claude/GPT routing has no equivalent remote usage endpoint, so those
// don't show up here.
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const CACHE_TTL_MS = 60_000;
const cache = new Map(); // auth file name -> { at, result }

async function fetchUserQuota(accessToken, projectId) {
  const res = await fetch(QUOTA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: projectId }),
  });
  if (!res.ok) {
    // Surface Google's own error message when present (e.g. 403
    // PERMISSION_DENIED/VALIDATION_REQUIRED, "Verify your account to
    // continue" -- an account-level security challenge from Google itself,
    // unrelated to our token/request) instead of a bare status code. That
    // error also carries a one-time `validation_url` link the account owner
    // has to open in a real signed-in browser tab to clear the challenge --
    // CLIProxyAPI's own OAuth re-login doesn't satisfy it.
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    let verifyUrl;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error?.message) message = `${parsed.error.message} (${parsed.error.status ?? res.status})`;
      const detail = (parsed?.error?.details ?? []).find((d) => d?.metadata?.validation_url);
      verifyUrl = detail?.metadata?.validation_url;
    } catch {
      // Non-JSON error body -- keep the bare status message.
    }
    const err = new Error(`retrieveUserQuota failed: ${message}`);
    err.status = res.status;
    err.verifyUrl = verifyUrl;
    throw err;
  }
  return res.json();
}

function toBucket(raw) {
  const usedPercent = typeof raw.remainingFraction === "number" ? Math.round((1 - raw.remainingFraction) * 100) : null;
  const resetAfterSeconds = raw.resetTime ? Math.max(0, Math.round((Date.parse(raw.resetTime) - Date.now()) / 1000)) : null;
  return { modelId: raw.modelId ?? null, usedPercent, resetAfterSeconds };
}

/**
 * Fetches real Gemini quota usage for one Antigravity auth file. Like
 * codex-usage.js, this reads access_token/project_id straight from the file
 * CLIProxyAPI already wrote (read-only, never refreshes the token itself --
 * an expired token is reported as `{ ok: false }` and left for CLIProxyAPI's
 * own refresh cycle). Returns the single most-used bucket as `worst` (for a
 * compact one-number summary) plus the full per-model `buckets` list.
 */
export async function getAntigravityUsage(name, filePath) {
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  let result;
  try {
    const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const accessToken = doc.access_token;
    const projectId = doc.project_id;
    if (!accessToken || !projectId) {
      result = { ok: false, reason: "auth file missing access_token/project_id" };
    } else {
      const data = await fetchUserQuota(accessToken, projectId);
      const buckets = Array.isArray(data.buckets) ? data.buckets.map(toBucket) : [];
      const worst = buckets.length
        ? buckets.reduce((a, b) => ((b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a))
        : null;
      result = { ok: true, worst, buckets };
    }
  } catch (err) {
    result = {
      ok: false,
      reason: err.status === 401 ? "token expired, waiting for refresh" : err.message,
      verifyUrl: err.verifyUrl,
    };
  }

  cache.set(name, { at: Date.now(), result });
  return result;
}
