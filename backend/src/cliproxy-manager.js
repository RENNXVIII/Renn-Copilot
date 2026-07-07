import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import yaml from "js-yaml";
import fetch from "node-fetch";
import extractZip from "extract-zip";
import * as tar from "tar";

import { settings, ensureDirs, binaryPath, configPath, managementBaseUrl } from "./settings.js";

const GITHUB_REPO = "router-for-me/CLIProxyAPI";

let childProcess = null;
let lastStartError = null;
const recentLogLines = [];
const MAX_LOG_LINES = 2000;

function pushLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  recentLogLines.push(stamped);
  if (recentLogLines.length > MAX_LOG_LINES) recentLogLines.shift();
}

export function getRecentLogs() {
  return recentLogLines;
}

export function isRunning() {
  return childProcess !== null && childProcess.exitCode === null;
}

export function getStatus() {
  return {
    running: isRunning(),
    pid: isRunning() ? childProcess.pid : null,
    binaryInstalled: fs.existsSync(binaryPath()),
    configExists: fs.existsSync(configPath()),
    lastStartError,
    home: settings.cliproxyHome,
    managementUrl: managementBaseUrl(),
  };
}

/** Maps Node's os.platform()/arch() to the naming scheme used by CLIProxyAPI's GitHub releases. */
function platformKeywords() {
  const platform = os.platform(); // 'win32' | 'linux' | 'darwin'
  const arch = os.arch(); // 'x64' | 'arm64' | ...
  const osKey = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const archKey = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
  return { osKey, archKey, platform };
}

async function fetchLatestReleaseAsset() {
  const tag = settings.cliproxyVersion === "latest" ? "latest" : `tags/${settings.cliproxyVersion}`;
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/${tag}`;
  const res = await fetch(url, { headers: { "User-Agent": "renn-copilot" } });
  if (!res.ok) throw new Error(`Failed to query GitHub releases (${res.status})`);
  const release = await res.json();
  const { osKey, archKey } = platformKeywords();

  const candidate = release.assets.find((asset) => {
    const name = asset.name.toLowerCase();
    return name.includes(osKey) && name.includes(archKey);
  });

  if (!candidate) {
    throw new Error(
      `No release asset found for ${osKey}/${archKey} in ${release.tag_name}. ` +
        `Available assets: ${release.assets.map((a) => a.name).join(", ")}`
    );
  }
  return { url: candidate.browser_download_url, name: candidate.name, version: release.tag_name };
}

async function downloadToFile(url, destPath) {
  const res = await fetch(url, { headers: { "User-Agent": "renn-copilot" } });
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const buffer = await res.arrayBuffer();
  await fsp.writeFile(destPath, Buffer.from(buffer));
}

/**
 * Copies a file, retrying briefly on EBUSY/EPERM. On Windows the OS keeps an
 * exclusive lock on a running .exe for a short moment after the process
 * object reports it has exited (the OS hasn't finished releasing the handle
 * yet) -- a plain copyFile right after kill() can still lose that race.
 */
async function copyFileWithRetry(src, dest, { attempts = 10, delayMs = 300 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await fsp.copyFile(src, dest);
      return;
    } catch (err) {
      const retryable = err.code === "EBUSY" || err.code === "EPERM";
      if (!retryable || i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Downloads (or re-downloads) the CLIProxyAPI binary for the current OS/arch. */
export async function installOrUpdateBinary() {
  ensureDirs();

  // Windows holds an exclusive lock on a running .exe -- overwriting it while
  // the server is up fails with EBUSY. Stop it first (and remember to bring
  // it back) instead of letting the copy race the OS's file lock.
  const wasRunning = isRunning();
  if (wasRunning) {
    pushLog("Stopping CLIProxyAPI before update (binary is in use)...");
    await stopServer();
  }

  try {
    const { name, url, version } = await fetchLatestReleaseAsset();
    pushLog(`Downloading CLIProxyAPI ${version} (${name})...`);

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cliproxy-dl-"));
    const archivePath = path.join(tmpDir, name);
    await downloadToFile(url, archivePath);

    if (name.endsWith(".zip")) {
      await extractZip(archivePath, { dir: tmpDir });
    } else if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
      await tar.x({ file: archivePath, cwd: tmpDir });
    } else {
      // Some releases ship the raw binary with no archive extension.
      await copyFileWithRetry(archivePath, binaryPath());
    }

    // Locate the extracted binary (it may be nested in a subfolder).
    const expectedName = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
    const found = await findFileRecursive(tmpDir, expectedName);
    if (found) {
      await copyFileWithRetry(found, binaryPath());
    }
    if (process.platform !== "win32") {
      await fsp.chmod(binaryPath(), 0o755);
    }

    await fsp.rm(tmpDir, { recursive: true, force: true });
    pushLog(`CLIProxyAPI ${version} installed at ${binaryPath()}`);
    return version;
  } finally {
    if (wasRunning) {
      pushLog("Restarting CLIProxyAPI after update...");
      await startServer();
    }
  }
}

async function findFileRecursive(dir, fileName) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileRecursive(full, fileName);
      if (nested) return nested;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return null;
}

/**
 * Keys we generate (management key + proxy API key) are mirrored into this
 * file, which only we ever write to. config.yaml's copies are NOT trusted as
 * the long-term source of truth: CLIProxyAPI's own docs note the management
 * key "will be hashed on startup", which means re-reading config.yaml after
 * CLIProxyAPI has run once can hand us back a hash instead of the plaintext
 * bearer token we're supposed to send -- causing every Management API call to
 * fail with 401 forever after (and, since the dashboard polls auth-files
 * every few seconds, that 401 loop is exactly what trips CLIProxyAPI's
 * "too many failed attempts" IP ban). Once we've captured a key, we keep
 * using our own copy instead of re-reading config.yaml.
 */
function ownKeysPath() {
  return path.join(settings.cliproxyHome, "renn-copilot-keys.json");
}

function loadOwnKeys() {
  try {
    return JSON.parse(fs.readFileSync(ownKeysPath(), "utf8"));
  } catch {
    return {};
  }
}

function saveOwnKeys(partial) {
  const next = { ...loadOwnKeys(), ...partial };
  fs.writeFileSync(ownKeysPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Writes a default config.yaml (with a generated management key + proxy API key) if one doesn't exist yet. */
export function ensureDefaultConfig() {
  ensureDirs();
  if (fs.existsSync(configPath())) {
    loadManagementKeyFromConfig();
    return ensureProxyApiKey();
  }

  const managementKey = settings.managementKey || crypto.randomBytes(24).toString("hex");
  const proxyApiKey = settings.proxyApiKey || crypto.randomBytes(24).toString("hex");
  const defaultConfig = {
    port: settings.cliproxyPort,
    host: settings.cliproxyHost,
    "auth-dir": path.join(settings.cliproxyHome, "auths"),
    debug: false,
    "request-log": true,
    "remote-management": {
      "allow-remote": false,
      "secret-key": managementKey,
    },
    // Required to call CLIProxyAPI's OpenAI-compatible surface (GET /v1/models,
    // /v1/chat/completions, etc.) -- the Management API key above does NOT work here.
    "api-keys": [proxyApiKey],
  };
  fs.writeFileSync(configPath(), yaml.dump(defaultConfig), "utf8");
  settings.managementKey = managementKey;
  settings.proxyApiKey = proxyApiKey;
  saveOwnKeys({ managementKey, proxyApiKey });
  pushLog(`Wrote default config.yaml with a generated management key + proxy API key.`);
  return proxyApiKey;
}

/**
 * Resolves the management key to use for Authorization headers. Prefers our
 * own pinned copy (see ownKeysPath above); only falls back to reading
 * config.yaml directly the first time we've never captured a key yet (e.g.
 * an existing CLIProxyAPI install set up before this file existed).
 */
export function loadManagementKeyFromConfig() {
  const ownKeys = loadOwnKeys();
  if (ownKeys.managementKey) {
    settings.managementKey = ownKeys.managementKey;
    return settings.managementKey;
  }

  if (!fs.existsSync(configPath())) return settings.managementKey;
  try {
    const doc = yaml.load(fs.readFileSync(configPath(), "utf8")) || {};
    const key = doc?.["remote-management"]?.["secret-key"];
    if (key) {
      settings.managementKey = key;
      saveOwnKeys({ managementKey: key }); // pin it -- don't re-read config.yaml after this
    }
  } catch (err) {
    pushLog(`Warning: could not parse config.yaml (${err.message})`);
  }
  return settings.managementKey;
}

/** Same pin-once-then-trust-our-own-copy strategy as loadManagementKeyFromConfig, for the proxy API key. */
export function loadProxyApiKeyFromConfig() {
  const ownKeys = loadOwnKeys();
  if (ownKeys.proxyApiKey) {
    settings.proxyApiKey = ownKeys.proxyApiKey;
    return settings.proxyApiKey;
  }

  if (!fs.existsSync(configPath())) return settings.proxyApiKey;
  try {
    const doc = yaml.load(fs.readFileSync(configPath(), "utf8")) || {};
    const key = Array.isArray(doc?.["api-keys"]) ? doc["api-keys"][0] : null;
    if (key) {
      settings.proxyApiKey = key;
      saveOwnKeys({ proxyApiKey: key });
    }
  } catch (err) {
    pushLog(`Warning: could not parse config.yaml (${err.message})`);
  }
  return settings.proxyApiKey;
}

/**
 * Backfills "api-keys" into an existing config.yaml that predates this feature
 * (configs written before we started generating a proxy API key). Requires a
 * server restart to take effect since CLIProxyAPI reads config.yaml at startup.
 */
export function ensureProxyApiKey() {
  if (!fs.existsSync(configPath())) return settings.proxyApiKey;
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(configPath(), "utf8")) || {};
  } catch (err) {
    pushLog(`Warning: could not parse config.yaml (${err.message})`);
    return settings.proxyApiKey;
  }

  if (Array.isArray(doc["api-keys"]) && doc["api-keys"].length > 0) {
    const fileKey = doc["api-keys"][0];
    settings.proxyApiKey = fileKey;
    saveOwnKeys({ proxyApiKey: fileKey });
    return fileKey;
  }

  const ownKeys = loadOwnKeys();
  const proxyApiKey = ownKeys.proxyApiKey || settings.proxyApiKey || crypto.randomBytes(24).toString("hex");
  doc["api-keys"] = [proxyApiKey];
  fs.writeFileSync(configPath(), yaml.dump(doc), "utf8");
  settings.proxyApiKey = proxyApiKey;
  saveOwnKeys({ proxyApiKey });
  pushLog(`Backfilled a proxy API key into config.yaml (restart CLIProxyAPI to apply).`);
  return proxyApiKey;
}

/**
 * Toggles whether CLIProxyAPI's OpenAI-compatible surface requires the
 * Bearer proxy API key at all. Needed for VS Code's "customoai" BYOK vendor
 * (chatLanguageModels.json), which -- unlike the "customendpoint" vendor --
 * never sends an Authorization header for requests it makes, so the proxy
 * has to be configured to not require one (confirmed empirically: an empty
 * api-keys array makes CLIProxyAPI accept every request unauthenticated).
 * CLIProxyAPI watches config.yaml and hot-reloads it, so no restart needed.
 */
export function setProxyAuthEnabled(enabled) {
  if (!fs.existsSync(configPath())) return { changed: false };
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(configPath(), "utf8")) || {};
  } catch (err) {
    pushLog(`Warning: could not parse config.yaml (${err.message})`);
    return { changed: false };
  }

  const ownKeys = loadOwnKeys();
  const proxyApiKey = ownKeys.proxyApiKey || settings.proxyApiKey;
  const nextKeys = enabled && proxyApiKey ? [proxyApiKey] : [];
  const currentKeys = Array.isArray(doc["api-keys"]) ? doc["api-keys"] : [];
  if (JSON.stringify(currentKeys) === JSON.stringify(nextKeys)) return { changed: false };

  doc["api-keys"] = nextKeys;
  fs.writeFileSync(configPath(), yaml.dump(doc), "utf8");
  pushLog(
    enabled
      ? "Re-enabled proxy API key authentication."
      : "Disabled proxy API key authentication (customoai BYOK vendor doesn't send one)."
  );
  return { changed: true };
}

export async function startServer() {
  if (isRunning()) return getStatus();
  if (!fs.existsSync(binaryPath())) {
    throw new Error("CLIProxyAPI binary not installed yet. Call /server/install first.");
  }
  ensureDefaultConfig();
  loadManagementKeyFromConfig();
  loadProxyApiKeyFromConfig();

  lastStartError = null;
  childProcess = spawn(binaryPath(), ["--config", configPath()], {
    cwd: settings.cliproxyHome,
    stdio: ["ignore", "pipe", "pipe"],
  });

  childProcess.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
  childProcess.stderr.on("data", (chunk) => pushLog(`[stderr] ${chunk.toString().trim()}`));
  childProcess.on("exit", (code) => {
    pushLog(`CLIProxyAPI exited with code ${code}`);
    if (code !== 0) lastStartError = `Process exited with code ${code}`;
    childProcess = null;
  });

  // Give it a moment to bind the port before we report "running".
  await new Promise((resolve) => setTimeout(resolve, 800));
  return getStatus();
}

export async function stopServer() {
  if (!isRunning()) return getStatus();
  childProcess.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  return getStatus();
}

export async function restartServer() {
  await stopServer();
  return startServer();
}
