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
app.use(cors());
app.use("/api", router);

app.get("/", (req, res) => res.json({ name: "renn-copilot-backend", status: "ok" }));

app.listen(settings.port, () => {
  console.log(`renn-copilot backend listening on http://127.0.0.1:${settings.port}`);
  console.log(`CLIProxyAPI home: ${settings.cliproxyHome}`);
});
