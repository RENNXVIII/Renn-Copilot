import fetch from "node-fetch";
import { proxyBaseUrl } from "./settings.js";
import { loadProxyApiKeyFromConfig } from "./cliproxy-manager.js";

/**
 * CLIProxyAPI's own OpenAI-compatible surface (not the Management API).
 * GET /v1/models reflects whatever the currently-logged-in accounts actually
 * support right now, which is the live source of truth -- the static
 * MODEL_CATALOG in model-catalog.js is only a label/grouping fallback for
 * when this call fails (server not running yet, no accounts logged in, etc.).
 */
export async function listLiveModelIds() {
  const key = loadProxyApiKeyFromConfig();
  if (!key) throw new Error("No proxy API key configured yet (start the server once to generate one).");

  const res = await fetch(`${proxyBaseUrl()}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`CLIProxyAPI /v1/models returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const message = data?.error?.message || data?.error || text;
    const err = new Error(`CLIProxyAPI /v1/models failed: ${res.status} ${message}`);
    err.status = res.status;
    throw err;
  }

  return Array.isArray(data?.data) ? data.data.map((m) => m.id).filter(Boolean) : [];
}
