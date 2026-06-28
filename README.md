# Renn Copilot

<img width="1867" height="940" alt="image" src="https://github.com/user-attachments/assets/4c07e53e-e34f-46c3-9df2-31a17d9bf201" />

Injects Gemini, Anthropic (Claude), and GPT models into GitHub Copilot Chat in VS Code, via
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its OAuth logins
(Antigravity, Claude web/Claude Code, Codex, plus Gemini CLI/Qwen/iFlow with a caveat
below). Ships as three independent pieces:

| Folder | What it is | Runs where |
|---|---|---|
| `backend/` | Node/Express service. Installs and runs the CLIProxyAPI binary, bridges its Management API, polls usage. | Locally, as a long-running process. |
| `dashboard/` | Next.js web app. Start/stop the server, OAuth login per provider, toggle which models are exposed, edit `config.yaml`, tail logs, track usage. | Locally, talks to the backend over HTTP. |
| `extension/` | Thin VS Code extension. Pulls the enabled-model list from the backend and writes it into Copilot Chat's BYOK setting using VS Code's official settings API. | Inside VS Code. |

The extension is intentionally the *only* thing that touches `settings.json`, and only
through `vscode.workspace.getConfiguration().update()` — never by editing the file
directly — to avoid clobbering entries you added yourself or racing with VS Code's own
writes. It tags every entry it manages with a hidden `rennCopilotManaged` flag so re-syncs
only touch what it previously wrote.

This is a **personal, local-first tool** — backend and dashboard are meant to run on your
own machine (or a box you control on your LAN), not as a public multi-tenant service.
There's no Docker/cloud deploy story here by design; "production" below just means
"running continuously and surviving reboots" rather than "dev mode with hot reload."

## Dashboard pages

| Page | What it does |
|---|---|
| Overview | Install/update the CLIProxyAPI binary, start/stop/restart it, at-a-glance status. |
| Providers & Login | OAuth login per provider, stored-credentials list with per-credential and bulk enable/disable, quota reset. |
| Models | Toggle which models are exposed to Copilot Chat, per-provider and global enable/disable, search/filter. |
| Usage | Token usage by provider/model (sortable, filterable, with cost estimate), account health, OAuth/API key usage. |
| Logs | Live tail of CLIProxyAPI's own request log and the backend's own process log, with search, copy, and download. |
| Config | Raw `config.yaml` editor (hidden by default), routing strategy (round-robin / fill-first), discard/save. |
| Extension | Compile, package (`.vsix`), and install the VS Code extension, with a live build log — no separate terminal needed. |

## Setup

Requires Node.js 18+. Run `npm install` in **each** of the three folders separately
(root `package.json` only wires up dev/build scripts for `backend` and `dashboard` as npm
workspaces; `extension` is a standalone VS Code extension project and isn't part of that
workspace):

```bash
cd backend && npm install
cd ../dashboard && npm install
cd ../extension && npm install
```

Then at the repo root (pulls in `concurrently`, used by `npm run dev`):

```bash
npm install
```

## Running locally (dev)

### One-door usage (recommended)

```bash
npm run dev
```

This starts backend + dashboard together in one terminal (labelled `backend`/`dashboard`,
color-coded, both with hot reload). Open `http://localhost:3000` — from there you can
start/stop CLIProxyAPI, log in to providers, toggle models, check usage, tail logs, **and
build/package/install the VS Code extension** without ever opening a second terminal. The
only things that still happen outside the dashboard are the very first `npm run dev` and
reloading the VS Code window after installing a new extension build.

### Backend (manual / standalone)

```bash
cd backend
cp .env.example .env   # adjust if you want a non-default port or CLIProxyAPI home dir
npm run dev
```

On first run it downloads the right CLIProxyAPI binary for your OS/arch from GitHub
Releases into `~/.renn-copilot/cliproxyapi` (configurable via `CLIPROXY_HOME`) and writes
a default `config.yaml` with a freshly generated management key. The backend listens on
port 4317 by default and exposes `/api/...` (see `backend/src/routes.js`).

### Dashboard (manual / standalone)

```bash
cd dashboard
npm run dev
```

Opens on `http://localhost:3000`. Set `NEXT_PUBLIC_BACKEND_URL` (copy
`dashboard/.env.example` to `dashboard/.env.local`) if your backend isn't on the default
`http://127.0.0.1:4317`.

### Extension — build via dashboard

Open the dashboard's "Extension" page and click **Build & Package (.vsix)** — this runs
`npm run package` inside `extension/` (which runs `vscode:prepublish` → `npm run
compile` automatically first, so a stale build can't ship). Once a `.vsix` exists, click
**Install to VS Code**, which shells out to the `code` CLI (`code --install-extension`).
If `code` isn't on your PATH yet, VS Code's Command Palette → "Shell Command: Install
'code' command in PATH" sets that up once. The build log streams live on that page either
way, so you don't lose visibility just because there's no terminal.

### Extension — manual

```bash
cd extension
npm run compile
npm run package   # produces a .vsix via vsce
```

Install the generated `.vsix` in VS Code (Extensions panel → "..." → Install from VSIX),
or run it from source via the VS Code Extension Development Host (F5) while iterating.

## Running in production (always-on)

"Production" here means: built once (not `next dev`'s hot-reload server), and kept alive
across terminal closes / reboots, so VS Code's extension always has somewhere to talk to.

### 1. Build the dashboard for production

```bash
cd dashboard
npm run build      # next build — do this once per change, not on every boot
```

### 2. Run both processes with a process manager

Plain `node`/`next start` work, but they die when your terminal closes and won't restart
on crash or reboot — use a process manager for anything you want running unattended.
[pm2](https://pm2.keymetrics.io/) is the easiest cross-platform option:

```bash
npm install -g pm2

# from the repo root
pm2 start backend/src/index.js --name renn-backend --cwd backend
pm2 start "npm run start" --name renn-dashboard --cwd dashboard

pm2 save              # remember this process list
pm2 startup            # (Linux/macOS) prints the command to auto-start pm2 on boot
```

On Windows, `pm2 startup` doesn't work the same way — use
[pm2-windows-startup](https://www.npmjs.com/package/pm2-windows-startup), or register
the two processes as Scheduled Tasks ("Run whether user is logged on or not", action =
`node`, with the right `Start in` working directory and arguments) as a lighter-weight
alternative to installing pm2 at all.

Useful pm2 commands afterwards: `pm2 logs`, `pm2 restart renn-backend`, `pm2 status`.

### 3. Re-run after every update

```bash
git pull
cd backend && npm install
cd ../dashboard && npm install && npm run build
pm2 restart renn-backend renn-dashboard
```

### Notes specific to running unattended

- The backend writes its management key and `config.yaml` to `CLIPROXY_HOME`
  (`~/.renn-copilot/cliproxyapi` by default) on first run — back that folder up if you
  reinstall the OS or move machines, otherwise every provider login has to be redone.
- `CLIPROXY_MANAGEMENT_KEY` in `backend/.env` is sensitive (it's the bearer token for
  CLIProxyAPI's Management API) — treat `backend/.env` like any other secrets file (don't
  commit it; it's already covered by the example/actual split in this repo).
- If you only ever use this from one machine, you generally don't need the dashboard
  running 24/7 — only the backend does, since that's what the VS Code extension and the
  CLIProxyAPI process itself depend on. Starting the dashboard on demand (`npm run dev` or
  `pm2 start ... renn-dashboard`) when you actually want to change settings is fine.

## Typical flow

1. Start the backend, open the dashboard.
2. On Overview, click "Install / Update binary" once, then "Start".
3. On Providers & Login, click "Login" for each provider you use — this opens the OAuth
   page in your browser; the dashboard polls until the token lands.
4. On Models, toggle which models should be exposed to Copilot Chat.
5. In VS Code, run "Renn Copilot: Sync Models from Dashboard" (or just reload — it syncs
   on startup by default). Then open Copilot Chat's model picker → "Manage Models..." and
   click the eye icon next to the new entries to actually enable them — VS Code requires
   that last step manually, there's no API to flip it for you.

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
  (see `backend/src/management-client.js`). The other three providers currently require
  driving CLIProxyAPI's own CLI `--login` flags directly on the machine running the
  backend; that flow isn't wired into the dashboard yet. `backend/src/routes.js` returns
  a clear 400 explaining this if you try to log in to one of them from the UI.
- **shadcn/ui**: the dashboard's `components/ui/*` are hand-written Tailwind primitives
  styled to match shadcn's conventions, not generated via `npx shadcn@latest add ...`.
  If you want the real generated components later, running the shadcn CLI against this
  same `tailwind.config.ts`/`globals.css` should slot in cleanly.
- **No automated tests** for `backend/` or `dashboard/` yet — changes are currently
  verified by `tsc --noEmit` (dashboard) and manual smoke-testing against a running
  CLIProxyAPI instance.
