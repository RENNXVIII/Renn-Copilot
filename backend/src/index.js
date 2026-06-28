import "dotenv/config";
import express from "express";
import cors from "cors";
import { settings, ensureDirs } from "./settings.js";
import { router } from "./routes.js";
import { ensureDefaultConfig } from "./cliproxy-manager.js";
import { startUsagePoller } from "./usage-poller.js";

ensureDirs();
ensureDefaultConfig();
startUsagePoller();

const app = express();
app.use(cors());
app.use("/api", router);

app.get("/", (req, res) => res.json({ name: "renn-copilot-backend", status: "ok" }));

app.listen(settings.port, () => {
  console.log(`renn-copilot backend listening on http://127.0.0.1:${settings.port}`);
  console.log(`CLIProxyAPI home: ${settings.cliproxyHome}`);
});
