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

// 1x1 transparent PNG -- smallest possible payload that's still a real image,
// so the probe below costs as little quota/tokens as it can while still
// exercising whatever multimodal path the backend actually has.
const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/**
 * Sends one real chat-completion request containing a test image to find out
 * whether `modelId` actually accepts image input, instead of assuming it does
 * (see model-catalog.js's toCopilotModelEntry doc for why that assumption was
 * wrong before). This costs real quota on whichever account serves the
 * model, so callers (routes.js) are responsible for only calling this once
 * per id and caching the result -- this function itself doesn't cache
 * anything.
 *
 * Returns { vision: true } on a normal success response.
 * Returns { vision: false, note } when the failure looks like the model/
 * backend explicitly rejecting image content (message mentions image/vision/
 * modality/multimodal).
 * Throws an Error with `.inconclusive = true` for anything else (auth, quota,
 * rate-limit, transient upstream errors) -- that's not evidence the model
 * lacks vision, just that this particular probe didn't get a clean answer,
 * so callers should leave the id unprobed rather than caching a wrong "false".
 */
export async function probeVisionSupport(modelId) {
  const key = loadProxyApiKeyFromConfig();
  if (!key) throw new Error("No proxy API key configured yet (start the server once to generate one).");

  const res = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Reply with just the word 'ok' if you received this message." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
          ],
        },
      ],
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`Vision probe for "${modelId}" got a non-JSON response: ${text.slice(0, 200)}`);
    err.inconclusive = true;
    throw err;
  }

  if (res.ok) return { vision: true };

  const message = String(data?.error?.message || data?.error || text || "").slice(0, 300);
  const looksLikeCapabilityRejection = /image|vision|modalit|multimodal|unsupported content/i.test(message);
  if (looksLikeCapabilityRejection) return { vision: false, note: message };

  const err = new Error(`Vision probe for "${modelId}" was inconclusive (HTTP ${res.status}): ${message}`);
  err.inconclusive = true;
  throw err;
}
