<div align="center">

# Renn Copilot

**Bring your own models to GitHub Copilot Chat — all inside VS Code.**

Inject Gemini, Claude, OpenAI/Codex, xAI/Grok, and any OpenAI-compatible model
into Copilot Chat through [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
No separate terminal. No browser tab. No extra process to babysit.

<br/>

[![Version](https://img.shields.io/badge/version-0.7.22-blue)](https://github.com/RENNXVIII/Renn-Copilot)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.95-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![Local-first](https://img.shields.io/badge/local--first-100%25-brightgreen)](#why-renn-copilot)
[![License](https://img.shields.io/badge/license-see%20LICENSE-lightgrey)](LICENSE)

</div>

---

## Why Renn Copilot

- **One extension, zero moving parts.** The backend and dashboard ship *inside*
  the `.vsix`. Install it and everything else starts itself.
- **Local-first & private.** The backend runs on your own machine — it is not a
  public, multi-tenant service.
- **Plays nice with your config.** It is the *only* thing that touches
  `chatLanguageModels.json`, and it edits *only* the single entry it owns — it
  never clobbers models you configured yourself.

## Supported providers

| Provider | Login method |
|---|---|
| **Antigravity** (Gemini) | Built-in OAuth |
| **Claude** (web / Claude Code) | Built-in OAuth |
| **Codex** (OpenAI) | Built-in OAuth |
| **xAI / Grok** | Device-code flow (SuperGrok / X Premium+) |
| **API keys** | Paste and go |
| **Custom OpenAI-compatible** | Add a base URL + key |

> Gemini CLI, Qwen, and iFlow have a caveat — see [Known gaps](#known-gaps).

---

## Quick start

1. **Install** the `.vsix` (Extensions panel → **⋯** → *Install from VSIX*).
   The backend starts automatically; nothing else to install.
2. **Open the dashboard** — Command Palette → **Renn Copilot: Open Dashboard**,
   or click the Activity Bar icon.
3. **Install the binary** — on the *Overview* page, click **Install binary**
   (use **Update version** later when a newer release ships).
4. **Log in** — on *Providers & Login*, sign in or paste an API key per provider.
   Antigravity, Claude, and Codex open their auth pages; xAI shows a device code
   in the dashboard; custom providers can be added directly.
5. **Pick models** — on *Models*, toggle what Copilot Chat should see.
6. **Sync** — models sync on startup, or run
   **Renn Copilot: Sync Models from Dashboard** any time. Reload VS Code if its
   model picker doesn't refresh, then enable the Renn Copilot entries under
   **Manage Models…**.

> With the default `rennCopilot.requireApiKey: false`, no proxy key is needed. If
> you enable it, a changed sync copies the generated key to your clipboard —
> paste it when VS Code prompts for the Renn Copilot Custom Endpoint key.

---

## The dashboard

Open it as a full **editor tab** (Command Palette → *Open Dashboard*) or as a
compact **Activity Bar sidebar**.

| Page | What it does |
|---|---|
| **Overview** | Install/update the CLIProxyAPI binary for your OS, compare installed vs. latest release, start/stop/restart, and watch status, health, and token trends — plus a top-model KPI, a success/fail meter, request mix by provider, and the runtime PID / management endpoint. |
| **Providers & Login** | Log in to Antigravity, Claude, Codex, or xAI; add API keys and custom providers; manage credential groups, enablement, and quota reset. Header shows connected/inactive credential counts at a glance. |
| **Models** | Toggle which models reach Copilot Chat — per-provider and global, with search, live vision verification, and manual Vision overrides. Header summarizes enabled/total models across providers. |
| **Usage** | Token usage by provider/model (sortable, filterable, with cost estimate) plus account and OAuth/API-key health, and a success-rate meter across all credentials. |
| **Activity** | A live-ish "neuron" view of your models — each one lights up as it's hit, sourced from usage (near-live, typically within ~15s). |
| **Logs** | Live tail of CLIProxyAPI's request log and the backend's process log, with search, copy, and download. |
| **Config** | Raw `config.yaml` editor (hidden by default) and routing strategy (round-robin / fill-first). |

The **sidebar** is a deliberate, focused summary — server status with
Start/Stop/Restart, a one-line health line, the enabled-model count, and quick
buttons for Sync Models / Copy API Key / Open Full Dashboard.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `rennCopilot.autoStartBackend` | `true` | Spawn the backend when VS Code starts. Turn off to start it manually. |
| `rennCopilot.autoStartServer` | `true` | Once the backend is up, auto-start the CLIProxyAPI server (like clicking *Start*). Takes effect after the binary is installed once. |
| `rennCopilot.autoSyncOnStartup` | `true` | Sync enabled models into Copilot's BYOK setting on startup. |
| `rennCopilot.backendUrl` | `http://127.0.0.1:4317` | Base URL the extension, webview, and backend share. Change only for advanced setups (e.g. a custom port). |
| `rennCopilot.requireApiKey` | `false` | Require VS Code to authenticate to the local proxy with its generated key. Off by default because some VS Code builds never show the key prompt. Enable only if your build prompts for and sends the key. |

## Commands

| Command | Purpose |
|---|---|
| **Open Dashboard** | Open the dashboard as an editor tab. |
| **Start / Stop Backend** | Manual control (handy when `autoStartBackend` is off). |
| **Sync Models from Dashboard** | Re-sync the enabled model list into Copilot's BYOK setting. |
| **Copy API Key to Clipboard** | Paste into VS Code's *Chat: Manage Language Models* dialog. |
| **Show Provider Account Health** | Quick-pick status of every stored credential. |

---

## Vision capability detection

Renn Copilot doesn't ship a "complete" global list of vision models — such lists
go stale fast and can't describe arbitrary custom providers. Instead it resolves
image-input support in order:

1. A per-model **Vision / No vision** manual override.
2. A successful **live verification** — asks the model to identify a property of
   a small test image.
3. **Curated metadata** for the handful of built-in models this project knows.
4. **Unknown** for everything else.

The Models page checks availability *without* sending chat requests. A live
vision check runs only when you click re-check or enable a model whose support
is still unknown — it uses a small amount of real quota. Auth, rate-limit,
quota, timeout, and upstream errors stay **Unknown** rather than being
mislabeled **No vision**.

Each check has a 30-second deadline and runs with bounded concurrency. Models
still marked Unknown are exported with `vision: false`; image attachments turn on
only after positive evidence or an explicit override. For a custom provider,
leave the selector on **Auto**, or pick **Vision** / **No vision** when its docs
are definitive.

---

## Building from source

Requires **Node.js 18+**.

```bash
# install dependencies (root, backend, webview)
npm install
npm install --prefix backend
npm install --prefix webview-ui

# build the .vsix (webview build + backend deps + vsce package)
npm run package
```

Install the generated `.vsix`, or press **F5** with this repo open to run it in
the VS Code Extension Development Host while iterating.

### Tests

```bash
npm test --prefix backend       # backend capability / provider / migration tests
npm test --prefix webview-ui    # webview pure-util tests (e.g. Activity graph)
npm run compile                 # type-check the extension host
npm run webview:build           # build the dashboard
```

Run `npm audit` independently in the root, `backend/`, and `webview-ui/`.

---

## Project layout

| Path | What it is |
|---|---|
| `src/` | The extension host — commands, status bar, backend lifecycle, and the dashboard's webview panel + sidebar. |
| `backend/` | A vendored Node/Express service. Installs and runs the CLIProxyAPI binary, bridges its Management API, and polls usage. Spawned automatically. |
| `webview-ui/` | The dashboard — a small React app rendered inside a VS Code webview, styled with VS Code theme variables, talking to `backend/` over HTTP. |

---

## Troubleshooting

<details>
<summary><strong>Logs page is empty for the "CLIProxyAPI" tab</strong> (<code>400 logging to file disabled</code>)</summary>

Harmless — CLIProxyAPI has request-logging-to-file turned off in its
`config.yaml`. Either ignore it (the *Backend* tab still shows our own log), or
enable it via the *Config* page by adding `logging-to-file: true` and saving.
</details>

<details>
<summary><strong>A Claude model rejects <code>temperature</code> / <code>top_p</code> / <code>top_k</code></strong></summary>

CLIProxyAPI now normalizes these for Claude-family requests upstream (stripping
`temperature`/`top_p`, plus `top_k` when extended thinking is active) before
forwarding to Anthropic — no extra handling needed here. Make sure the backend
is running and re-sync the affected model so its endpoint is current.
</details>

---

## Known gaps

- **Gemini CLI / Qwen / iFlow OAuth** aren't wired into the dashboard yet.
  CLIProxyAPI exposes ready-made OAuth endpoints for Antigravity, Anthropic, and
  Codex (and Renn Copilot implements xAI's device-code flow), but these three
  still need CLIProxyAPI's own CLI `--login` flags on the backend machine.
- **Custom OpenAI-compatible providers** vary in metadata and error behavior.
  When a provider doesn't expose definitive vision metadata, use live
  verification or a manual override on the Models page.
