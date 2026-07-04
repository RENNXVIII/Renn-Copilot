# Renn Copilot

<img width="1920" height="658" alt="image" src="https://github.com/user-attachments/assets/86136ae4-a60e-4f2d-8427-8372c188cecd" />

Injects Gemini, Anthropic (Claude), and GPT models into GitHub Copilot Chat in VS Code, via
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its OAuth logins
(Antigravity, Claude web/Claude Code, Codex, plus Gemini CLI/Qwen/iFlow with a caveat
below).

Everything lives inside a **single, self-contained VS Code extension** — no separate
terminal, no browser tab, no other process to start by hand:

| Path | What it is |
|---|---|
| `src/` | The extension host: commands, status bar, backend lifecycle (spawn/stop), and the dashboard's webview panel + sidebar view. |
| `backend/` | Node/Express service, vendored inside the extension. Installs and runs the CLIProxyAPI binary, bridges its Management API, polls usage. Spawned automatically by the extension — you never run `npm run dev` for this yourself. |
| `webview-ui/` | The dashboard itself: a small React app that renders inside a VS Code webview (editor tab or Activity Bar sidebar), styled with VS Code's own theme variables. Talks to `backend/` directly over HTTP. |

The extension is intentionally the *only* thing that touches `chatLanguageModels.json`,
and only through reading/writing that one file directly, replacing just the single entry
it owns — never clobbering anything else you've configured there yourself.

This is a **personal, local-first tool** — the backend runs on your own machine (spawned
by the extension), not as a public multi-tenant service.

## Dashboard

- **Command Palette → "Renn Copilot: Open Dashboard"** — the full dashboard as an editor tab:

  | Page | What it does |
  |---|---|
  | Overview | Install/update the CLIProxyAPI binary, start/stop/restart it, at-a-glance status, setup checklist, health monitor, token trend. |
  | Providers & Login | OAuth login per provider, stored-credentials list with per-credential and bulk enable/disable, quota reset. |
  | Models | Toggle which models are exposed to Copilot Chat, per-provider and global enable/disable, search/filter, vision-capability verification. |
  | Usage | Token usage by provider/model (sortable, filterable, with cost estimate), account health, OAuth/API key usage. |
  | Logs | Live tail of CLIProxyAPI's own request log and the backend's own process log, with search, copy, and download. |
  | Config | Raw `config.yaml` editor (hidden by default), routing strategy (round-robin / fill-first), discard/save. |

- **Activity Bar icon** — a compact sidebar (deliberately not a squeezed-down copy of all
  6 pages): server status with Start/Stop/Restart, a one-line health summary, enabled
  model count linking straight to the Models page, and quick buttons for Sync Models /
  Copy API Key / Open Full Dashboard.

## Setup

Requires Node.js 18+ only if you're building from source. End users just install the
`.vsix` (Extensions panel → "..." → Install from VSIX) — the backend's dependencies ship
inside it, so nothing else needs installing on the machine running VS Code.

Building from source:

```bash
npm install
npm install --prefix backend
npm install --prefix webview-ui
```

Then, from the repo root:

```bash
npm run package   # builds the webview, installs backend deps, produces a .vsix via vsce
```

Install the generated `.vsix` (Extensions panel → "..." → Install from VSIX), or run it
from source via the VS Code Extension Development Host (press **F5** with this repo
open as the workspace) while iterating.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `rennCopilot.autoStartBackend` | `true` | Automatically spawn the backend when VS Code starts. Disable to start it manually via **"Renn Copilot: Start Backend"**. |
| `rennCopilot.autoStartServer` | `true` | Once the backend is up, automatically start the CLIProxyAPI server too (same as clicking "Start" on the Overview page). Only takes effect once the binary has been installed at least once. |
| `rennCopilot.autoSyncOnStartup` | `true` | Automatically sync enabled models into Copilot's BYOK setting when VS Code starts. |
| `rennCopilot.backendUrl` | `http://127.0.0.1:4317` | Base URL the extension, webview, and backend agree on. Only change this for advanced setups (e.g. a non-default port). |

## Commands

- **Renn Copilot: Open Dashboard** — opens the dashboard as an editor tab (also available via the Activity Bar sidebar icon).
- **Renn Copilot: Start Backend** / **Stop Backend** — manual control, mainly useful when `autoStartBackend` is off.
- **Renn Copilot: Sync Models from Dashboard** — re-syncs the enabled model list into Copilot's BYOK setting.
- **Renn Copilot: Copy API Key to Clipboard** — for pasting into VS Code's "Chat: Manage Language Models" dialog.
- **Renn Copilot: Show Provider Account Health** — quick-pick breakdown of every stored credential's status.

## Typical flow

1. Install the extension. The backend (and, by default, the CLIProxyAPI server once its binary is installed) spawn automatically.
2. Open the dashboard (Command Palette or Activity Bar icon). On first run, click "Install / Update binary" once on the Overview page.
3. On Providers & Login, click "Login" for each provider you use — this opens the OAuth page in your browser; the dashboard polls until the token lands.
4. On Models, toggle which models should be exposed to Copilot Chat.
5. Reload VS Code (models sync on startup by default, or run "Renn Copilot: Sync Models" manually) — whenever the synced model list actually changes, the API key is copied to your clipboard automatically. Open Copilot Chat's model picker → "Manage Models..." and click the eye icon next to the new entries to enable them; when VS Code prompts for the API key, just paste (Ctrl+V / Cmd+V) and press Enter.

## Troubleshooting

- **Logs page shows nothing for the "CLIProxyAPI" tab, with `Management API GET /logs
  failed: 400 logging to file disabled` in the backend's console.** Harmless — CLIProxyAPI
  itself has request-logging-to-file turned off in its `config.yaml`. Either ignore it (the
  Backend tab on the same page still shows our own process log), or enable it via the
  dashboard's Config page by adding a `logging-to-file: true` key and saving.
- **Claude Opus 4.7+ requests fail with `temperature is deprecated for this model`.** A
  known, still-unpatched upstream CLIProxyAPI issue as of mid-2026 — it doesn't strip
  deprecated sampling params (`temperature`/`top_p`/`top_k`) per-model before forwarding.
  `logging-proxy.js` at the repo root is a small standalone diagnostic/hotfix proxy that
  sits between VS Code and CLIProxyAPI, strips those params only for the affected models,
  and logs the raw request/response for debugging. Run with `node logging-proxy.js`, then
  point the affected model entries in Copilot's BYOK settings at port `8318` instead of
  `8317` temporarily, and revert once upstream fixes it.

## Known gaps

- **Gemini CLI / Qwen / iFlow OAuth**: CLIProxyAPI's Management API only exposes
  ready-made OAuth-URL endpoints for `antigravity`, `anthropic` (Claude), and `codex`
  (see `backend/src/management-client.js`). The other three providers currently
  require driving CLIProxyAPI's own CLI `--login` flags directly on the machine running
  the backend; that flow isn't wired into the dashboard yet. `backend/src/routes.js`
  returns a clear 400 explaining this if you try to log in to one of them from the UI.
- **No automated tests** yet — changes are currently verified by `tsc` (extension host +
  webview) and manual smoke-testing against a running CLIProxyAPI instance.
