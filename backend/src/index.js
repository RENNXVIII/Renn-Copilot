import "dotenv/config";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { settings, ensureDirs, binaryPath } from "./settings.js";
import { router } from "./routes.js";
import { ensureDefaultConfig, startServer } from "./cliproxy-manager.js";
import { startUsagePoller } from "./usage-poller.js";

ensureDirs();
ensureDefaultConfig();
startUsagePoller();

// Set by the VS Code extension (RENN_AUTO_START_SERVER=1) when the user has
// rennCopilot.autoStartServer enabled -- mirrors clicking "Start" on the
// Overview page, but only if the binary is already installed (first-time
// setup still requires a manual "Install / Update binary" click once).
if (process.env.RENN_AUTO_START_SERVER === "1" && fs.existsSync(binaryPath())) {
  startServer().catch((err) => {
    console.error(`Auto-start of CLIProxyAPI failed: ${err.message}`);
  });
}

const app = express();
// This API has no auth of its own (it trusts anything that can reach
// 127.0.0.1:<port>) and can leak the proxy API key, delete stored OAuth
// credentials, and overwrite config.yaml -- so CORS must not allow ordinary
// websites to reach it. The only legitimate cross-origin caller is this
// extension's own webview (origin "vscode-webview://..."); Node-side callers
// (the extension host's fetchJson, curl, etc.) send no Origin header at all.
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("vscode-webview://")) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);
app.use("/api", router);

app.get("/", (req, res) => res.json({ name: "renn-copilot-backend", status: "ok" }));

app.listen(settings.port, () => {
  console.log(`renn-copilot backend listening on http://127.0.0.1:${settings.port}`);
  console.log(`CLIProxyAPI home: ${settings.cliproxyHome}`);
});
