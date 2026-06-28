// Temporary diagnostic proxy: logs the exact headers + body VS Code sends,
// then forwards the request unchanged to the real CLIProxyAPI on 8317.
// Run with: node logging-proxy.js
// Then point chatLanguageModels.json's "Renn Copilot" model URLs at 8318
// instead of 8317 (temporarily), reload VS Code, retry the chat, and read
// what gets printed here. Revert the URLs afterwards.

const http = require("http");

const TARGET_HOST = "127.0.0.1";
const TARGET_PORT = 8317;
const LISTEN_PORT = 8318;

// Anthropic deprecated `temperature` (and `top_p`/`top_k`) entirely for the
// Opus 4.7+ model family — any request that includes these fields gets a
// hard 400 "`temperature` is deprecated for this model", regardless of the
// value sent. This is a known, still-unpatched issue upstream in CLIProxyAPI
// as of June 2026 (no changelog/release/issue indicates a per-model strip),
// so we hotfix it here: strip the deprecated sampling params before
// forwarding, but only for the affected models, so other models that still
// rely on temperature/top_p keep working unchanged.
const DEPRECATED_SAMPLING_PARAMS_MODELS = /^claude-opus-4-[789]/;
const SAMPLING_PARAMS_TO_STRIP = ["temperature", "top_p", "top_k"];

function stripDeprecatedSamplingParams(rawBody) {
  if (!rawBody) return rawBody;
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Not JSON (e.g. SSE passthrough or empty body) — forward unchanged.
    return rawBody;
  }

  if (
    typeof parsed.model === "string" &&
    DEPRECATED_SAMPLING_PARAMS_MODELS.test(parsed.model)
  ) {
    let stripped = false;
    for (const key of SAMPLING_PARAMS_TO_STRIP) {
      if (key in parsed) {
        delete parsed[key];
        stripped = true;
      }
    }
    if (stripped) {
      console.log(
        `[hotfix] stripped deprecated sampling params for model "${parsed.model}"`
      );
      return JSON.stringify(parsed);
    }
  }
  return rawBody;
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      console.log("\n===== Incoming request =====");
      console.log(`${req.method} ${req.url}`);
      console.log("Headers:", JSON.stringify(req.headers, null, 2));
      console.log("Body:", body);
      console.log("=============================\n");

      body = stripDeprecatedSamplingParams(body);

      // Body size may have changed after stripping fields above — recompute
      // Content-Length, otherwise CLIProxyAPI will hang waiting for bytes
      // that never arrive (or truncate the JSON) if it differs from the
      // original.
      const outgoingHeaders = { ...req.headers };
      if (outgoingHeaders["content-length"] !== undefined) {
        outgoingHeaders["content-length"] = Buffer.byteLength(body);
      }

      const proxyReq = http.request(
        {
          host: TARGET_HOST,
          port: TARGET_PORT,
          path: req.url,
          method: req.method,
          headers: outgoingHeaders,
        },
        (proxyRes) => {
          console.log(`<- Upstream responded ${proxyRes.statusCode}`);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);

          // On error, log the upstream response body too (not just the
          // status code) — we still pipe every chunk through to the client
          // unchanged, just tee a copy into the log for non-2xx responses.
          if (proxyRes.statusCode >= 400) {
            const chunks = [];
            proxyRes.on("data", (chunk) => {
              chunks.push(chunk);
              res.write(chunk);
            });
            proxyRes.on("end", () => {
              console.log(
                `<- Upstream error body: ${Buffer.concat(chunks).toString("utf8")}`
              );
              res.end();
            });
          } else {
            proxyRes.pipe(res);
          }
        }
      );
      proxyReq.on("error", (err) => {
        console.error("Proxy error:", err.message);
        res.writeHead(502);
        res.end(String(err));
      });
      proxyReq.write(body);
      proxyReq.end();
    });
  })
  .listen(LISTEN_PORT, () => {
    console.log(`Logging proxy listening on http://127.0.0.1:${LISTEN_PORT}, forwarding to :${TARGET_PORT}`);
  });
