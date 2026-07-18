import { Readable } from "node:stream";
import { proxyBaseUrl } from "./settings.js";

// Anthropic hard-rejects non-default top_p/temperature/top_k on Claude
// Opus 4.7+ / Sonnet 4.5+ ("top_p is deprecated for this model", HTTP 400).
// VS Code's Copilot Chat still sends these as request defaults regardless of
// model, and CLIProxyAPI forwards them to Anthropic unmodified -- so this
// strips them for Claude-family requests before proxying to CLIProxyAPI's
// real /v1/chat/completions. Other providers (Gemini, GPT) go straight to
// CLIProxyAPI without this hop -- see model-catalog.js's toCopilotModelEntry.
const DEPRECATED_SAMPLING_PARAMS = ["top_p", "temperature", "top_k"];

export async function proxyChatCompletions(req, res) {
  const body = { ...req.body };
  if (typeof body.model === "string" && /claude/i.test(body.model)) {
    for (const key of DEPRECATED_SAMPLING_PARAMS) delete body[key];
  }

  const upstream = await fetch(`${proxyBaseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept-Encoding": "identity",
      // Pass through whatever Authorization the client sent verbatim --
      // this proxy doesn't own auth, CLIProxyAPI's own proxy-auth setting
      // (see cliproxy-manager.js's setProxyAuthEnabled) still applies.
      ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
    },
    body: JSON.stringify(body),
  });

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Node/Express recomputes these for its own response -- forwarding
    // CLIProxyAPI's original values here would corrupt the stream.
    if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding" || lower === "connection") return;
    res.setHeader(key, value);
  });

  if (!upstream.body) {
    res.end();
    return;
  }

  const upstreamStream = Readable.fromWeb(upstream.body);

  // A mid-stream error on the upstream body (CLIProxyAPI dropping the
  // connection, a network blip during a long Claude response) would
  // otherwise be an unhandled stream 'error' event -- which crashes the
  // whole backend process, not just this one request. Tear the response
  // down cleanly instead. Also stop pulling from upstream if the client
  // (VS Code) disconnects first, so an abandoned request doesn't keep a
  // CLIProxyAPI stream open.
  upstreamStream.on("error", (err) => {
    console.error(`Claude proxy stream error: ${err.message}`);
    res.destroy(err);
  });
  res.on("close", () => upstreamStream.destroy());
  upstreamStream.pipe(res);
}
