# Renn Copilot

Injects Gemini, Anthropic (Claude), OpenAI/Codex, xAI/Grok, and arbitrary
OpenAI-compatible models into GitHub Copilot Chat in VS Code through
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). Built-in login flows cover
Antigravity, Claude web/Claude Code, Codex, and xAI; API-key and custom-provider entries
are managed from the same dashboard. Gemini CLI/Qwen/iFlow have a caveat described
under [Known gaps](#known-gaps).

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
  | Overview | Install or update the OS/architecture-specific CLIProxyAPI binary, compare the installed and latest GitHub versions, start/stop/restart it, and view status, setup, health, and token trends. |
  | Providers & Login | Login to Antigravity, Claude, Codex, or xAI; add API keys and custom OpenAI-compatible providers; manage credential prefixes/groups, stored credentials, enablement, and quota reset. xAI uses a device-code flow for SuperGrok/X Premium+ accounts. |
  | Models | Toggle which models are exposed to Copilot Chat, per-provider and global enable/disable, search/filter, live vision verification, and manual Vision/No vision overrides. |
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
| `rennCopilot.requireApiKey` | `false` | Require VS Code to authenticate to the local proxy with its generated API key. It is off by default because some VS Code builds never show the Custom Endpoint API-key prompt; with the setting off, the local proxy is configured without proxy authentication. Enable it only when your VS Code build prompts for and sends the key. |

## Commands

- **Renn Copilot: Open Dashboard** — opens the dashboard as an editor tab (also available via the Activity Bar sidebar icon).
- **Renn Copilot: Start Backend** / **Stop Backend** — manual control, mainly useful when `autoStartBackend` is off.
- **Renn Copilot: Sync Models from Dashboard** — re-syncs the enabled model list into Copilot's BYOK setting.
- **Renn Copilot: Copy API Key to Clipboard** — for pasting into VS Code's "Chat: Manage Language Models" dialog.
- **Renn Copilot: Show Provider Account Health** — quick-pick breakdown of every stored credential's status.

## Typical flow

1. Install the extension. The backend (and, by default, the CLIProxyAPI server once its binary is installed) starts automatically.
2. Open the dashboard (Command Palette or Activity Bar icon). On first run, click **Install binary** on the Overview page. Later, use **Update version** when a newer GitHub release is available.
3. On Providers & Login, log in or add an API key for each provider you use. Antigravity, Claude, and Codex open their authorization pages; xAI opens a device-code approval page and shows the code in the dashboard. Custom OpenAI-compatible providers can be added directly.
4. On Models, toggle which models should be exposed to Copilot Chat.
5. Models sync on startup by default, or run **Renn Copilot: Sync Models from Dashboard** manually. Reload VS Code if its model picker does not refresh, then open **Manage Models...** and click the eye icon next to the Renn Copilot entries you want visible.
6. With the default `rennCopilot.requireApiKey: false`, no proxy key is required. If you enable that setting, a changed sync copies the generated key to your clipboard; paste it when VS Code prompts for the Renn Copilot Custom Endpoint key.

## Vision capability detection

Renn Copilot does not maintain a supposedly complete global list of vision
models. Such lists become stale quickly and cannot reliably describe arbitrary
OpenAI-compatible custom providers. It instead resolves image-input support in
this order:

1. A per-model **Vision / No vision** manual override.
2. A successful live verification request that asks the model to identify a
  visual property of a small test image.
3. Curated metadata for the small set of built-in models known by this project.
4. **Unknown** for every other model.

The Models page polls model availability without sending chat requests. A live
vision verification is sent only when you click the re-check button or enable a
model whose support is still unknown. It consumes a small amount of real
provider quota. Authentication, rate-limit, quota, timeout, and upstream errors
remain **Unknown** rather than being misclassified as **No vision**.

Each verification has a 30-second deadline. When several newly enabled models
need verification, requests are processed with bounded concurrency rather than
as an unbounded burst.

For a custom provider, leave the selector on **Auto** to use live verification,
or choose **Vision** / **No vision** when the provider's documentation gives a
definitive answer. Models still marked Unknown are exported to VS Code with
`vision: false`; image attachments are enabled only after positive evidence or
an explicit override.

## Troubleshooting

- **Logs page shows nothing for the "CLIProxyAPI" tab, with `Management API GET /logs
  failed: 400 logging to file disabled` in the backend's console.** Harmless — CLIProxyAPI
  itself has request-logging-to-file turned off in its `config.yaml`. Either ignore it (the
  Backend tab on the same page still shows our own process log), or enable it via the
  dashboard's Config page by adding a `logging-to-file: true` key and saving.
- **A Claude-family model rejects deprecated sampling parameters such as
  `temperature`, `top_p`, or `top_k`.** CLIProxyAPI now normalizes these parameters for
  Claude-family requests upstream (stripping `temperature`/`top_p`, plus `top_k` when
  extended thinking is active) before forwarding to Anthropic, so no extra handling is
  needed on the extension side. Ensure the backend is running and re-sync the affected
  model so its endpoint is current.

## Known gaps

- **Gemini CLI / Qwen / iFlow OAuth**: CLIProxyAPI's Management API exposes ready-made
  OAuth URL endpoints for Antigravity, Anthropic, and Codex, while Renn Copilot separately
  implements xAI's device-code CLI flow. Gemini CLI, Qwen, and iFlow still require
  CLIProxyAPI's own CLI `--login` flags on the machine running the backend; those flows are
  not wired into the dashboard yet.
- Custom OpenAI-compatible providers vary in model metadata and error behavior. When a
  provider does not expose definitive vision metadata, use live verification or a manual
  override on the Models page.

## Validation and tests

The backend includes automated Node tests for model capability evidence, provider-scoped
keys, legacy migration, custom-provider attribution, and fallback model export. The main
validation commands are:

```bash
npm test --prefix backend
npm run compile
npm run webview:build
```

Dependency audits can be run independently in the repository root, `backend/`, and
`webview-ui/` with `npm audit`.
