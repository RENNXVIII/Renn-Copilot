import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { extensionDir, settings } from "./settings.js";

const MAX_LOG_LINES = 2000;
const logLines = [];

let busy = false;
let lastTask = null; // "compile" | "package" | "install" | null
let lastExitCode = null;
let lastError = null;
let lastVsix = null;

// lastTask/lastExitCode/lastError/lastVsix above only live in memory -- a
// backend restart (e.g. the dev `node --watch` script reloading after an
// edit) used to wipe out the "what happened last time" info the dashboard
// shows. Persist it next to CLIProxyAPI's own state file, same pattern as
// the pinned management/proxy API keys in cliproxy-manager.js.
function statePath() {
  return path.join(settings.cliproxyHome, "extension-build-state.json");
}

function loadPersistedState() {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    lastTask = saved.lastTask ?? null;
    lastExitCode = saved.lastExitCode ?? null;
    lastError = saved.lastError ?? null;
    lastVsix = saved.lastVsix ?? null;
  } catch {
    // No state file yet, or it's corrupt -- start fresh.
  }
}

function persistState() {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(
      statePath(),
      JSON.stringify({ lastTask, lastExitCode, lastError, lastVsix }, null, 2),
      "utf8"
    );
  } catch {
    // Best-effort -- losing this on a write failure isn't worth crashing over.
  }
}

loadPersistedState();

function pushLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  logLines.push(stamped);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
}

export function getExtensionLogs() {
  return logLines;
}

export function getExtensionStatus() {
  // Fall back to scanning the folder if we don't have a remembered .vsix --
  // covers the case where the state file predates this feature, or someone
  // built/copied a .vsix in by hand outside the dashboard.
  const vsix = lastVsix || findLatestVsix();
  return {
    busy,
    lastTask,
    lastExitCode,
    lastError,
    lastVsix: vsix,
    extensionDir: extensionDir(),
    dirExists: fs.existsSync(extensionDir()),
  };
}

function findLatestVsix() {
  const dir = extensionDir();
  if (!fs.existsSync(dir)) return null;
  const vsixFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".vsix"));
  if (!vsixFiles.length) return null;
  const withStats = vsixFiles.map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }));
  withStats.sort((a, b) => b.mtime - a.mtime);
  return path.join(dir, withStats[0].f);
}

function runNpmScript(task, scriptName) {
  if (busy) {
    return Promise.reject(new Error(`Already running "${lastTask}" -- wait for it to finish first.`));
  }
  if (!fs.existsSync(extensionDir())) {
    return Promise.reject(new Error(`extension/ folder not found at ${extensionDir()}`));
  }

  busy = true;
  lastTask = task;
  lastError = null;
  lastExitCode = null;
  pushLog(`--- npm run ${scriptName} (cwd=${extensionDir()}) ---`);

  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    // On Windows, npm resolves to npm.cmd, a batch file -- spawn() can't exec
    // those directly (throws EINVAL since Node 18ish) without shell: true.
    const child = spawn("npm", ["run", scriptName], {
      cwd: extensionDir(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });

    child.stdout.on("data", (chunk) => pushLog(chunk.toString().trimEnd()));
    child.stderr.on("data", (chunk) => pushLog(`[stderr] ${chunk.toString().trimEnd()}`));

    child.on("error", (err) => {
      busy = false;
      lastError = `Failed to spawn npm: ${err.message}`;
      pushLog(lastError);
      persistState();
      reject(new Error(lastError));
    });

    child.on("exit", (code) => {
      busy = false;
      lastExitCode = code;
      if (code !== 0) {
        lastError = `"npm run ${scriptName}" exited with code ${code}`;
        pushLog(lastError);
        persistState();
        reject(new Error(lastError));
        return;
      }
      pushLog(`"npm run ${scriptName}" finished successfully.`);
      if (task === "package") {
        lastVsix = findLatestVsix();
        if (lastVsix) pushLog(`Found package: ${lastVsix}`);
      }
      persistState();
      resolve(getExtensionStatus());
    });
  });
}

/** Type-checks/compiles src/*.ts -> out/*.js without packaging. Useful to catch errors fast. */
export function compileExtension() {
  return runNpmScript("compile", "compile");
}

/**
 * Builds the .vsix. "vscode:prepublish" (added to extension/package.json) runs
 * compile automatically first, so this alone always ships a fresh build.
 */
export function packageExtension() {
  return runNpmScript("package", "package");
}

/** Installs the most recently built .vsix into VS Code via the `code` CLI, if it's on PATH. */
export function installExtension(vsixPath) {
  const target = vsixPath || lastVsix || findLatestVsix();
  if (!target) {
    return Promise.reject(new Error('No .vsix found yet -- click "Package" first.'));
  }
  if (busy) {
    return Promise.reject(new Error(`Already running "${lastTask}" -- wait for it to finish first.`));
  }

  busy = true;
  lastTask = "install";
  lastError = null;
  pushLog(`--- code --install-extension ${target} ---`);

  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn("code", ["--install-extension", target], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });

    child.stdout.on("data", (chunk) => pushLog(chunk.toString().trimEnd()));
    child.stderr.on("data", (chunk) => pushLog(`[stderr] ${chunk.toString().trimEnd()}`));

    child.on("error", (err) => {
      busy = false;
      lastError =
        `Could not run the "code" CLI (${err.message}). In VS Code, run Command Palette -> ` +
        `"Shell Command: Install 'code' command in PATH", then try again -- or install the .vsix ` +
        `manually from the Extensions view ("Install from VSIX...").`;
      pushLog(lastError);
      persistState();
      reject(new Error(lastError));
    });

    child.on("exit", (code) => {
      busy = false;
      lastExitCode = code;
      if (code !== 0) {
        lastError = `"code --install-extension" exited with code ${code}`;
        pushLog(lastError);
        persistState();
        reject(new Error(lastError));
        return;
      }
      pushLog(`Installed ${target} into VS Code. Reload the VS Code window to activate it.`);
      persistState();
      resolve(getExtensionStatus());
    });
  });
}
