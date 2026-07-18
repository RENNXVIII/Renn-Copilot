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

// 16x16 solid red PNG. Unlike a transparent pixel, this gives the model a
// visual fact it must inspect, allowing us to catch endpoints that accept an
// image_url payload but silently discard it before invoking a text-only model.
const PROBE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

export function classifyVisionProbeResponse({ ok, status, data, text = "" }) {
  const message = String(data?.error?.message || data?.error || text || "").slice(0, 300);
  if (!ok) {
    const looksLikeCapabilityRejection =
      /(?:does not|doesn't|not|no longer) support(?:ed)? (?:image|vision|multimodal)|(?:image|vision|multimodal|image_url)(?: input| content)? (?:is |are )?(?:not supported|unsupported)|unsupported (?:image|vision|multimodal|image_url|content type)|(?:image|vision|multimodal|image_url) content is unsupported/i.test(message);
    if (looksLikeCapabilityRejection && ![401, 403, 408, 409, 429].includes(status) && status < 500) {
      return { vision: false, source: "probe", note: message };
    }
    return { vision: "unknown", source: "probe", note: `Vision probe was inconclusive (HTTP ${status}): ${message}` };
  }

  const content = data?.choices?.[0]?.message?.content;
  const answer = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text || "").join(" ")
      : "";

  if (/\bred\b/i.test(answer)) return { vision: true, source: "probe" };
  return {
    vision: "unknown",
    source: "probe",
    note: "The endpoint accepted image content, but the response did not identify the red test image.",
  };
}

/**
 * Sends one real chat-completion request containing a test image to find out
 * whether `modelId` actually accepts image input, instead of assuming it does
 * (see model-catalog.js's toCopilotModelEntry doc for why that assumption was
 * wrong before). This costs real quota on whichever account serves the
 * model, so callers (routes.js) are responsible for only calling this once
 * per id and caching the result -- this function itself doesn't cache
 * anything.
 *
 * Returns { vision: true, source: "probe" } only when the response correctly
 * identifies the visual fact in the image.
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let res;
  let text;
  try {
    res = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        max_tokens: 16,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is the dominant color of this image? Reply with one lowercase color word only." },
              { type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    if (err.name === "AbortError") {
      const timeoutError = new Error(`Vision probe for "${modelId}" timed out after 30000ms.`);
      timeoutError.inconclusive = true;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const err = new Error(`Vision probe for "${modelId}" got a non-JSON response: ${text.slice(0, 200)}`);
    err.inconclusive = true;
    throw err;
  }

  const result = classifyVisionProbeResponse({ ok: res.ok, status: res.status, data, text });
  if (result.vision !== "unknown") return result;

  const err = new Error(result.note);
  err.inconclusive = true;
  throw err;
}
