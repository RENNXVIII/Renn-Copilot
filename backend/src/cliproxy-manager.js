import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import yaml from "js-yaml";
import extractZip from "extract-zip";
import * as tar from "tar";

import { settings, ensureDirs, binaryPath, configPath, managementBaseUrl } from "./settings.js";

const GITHUB_REPO = "router-for-me/CLIProxyAPI";
const execFileAsync = promisify(execFile);
const RELEASE_CACHE_MS = 5 * 60 * 1000;
let releaseCache = null;
let installedVersionCache = null;

// Surgically patches (or inserts) a single top-level scalar key in raw
// config.yaml text, instead of yaml.load()-then-yaml.dump()-ing the whole
// document -- a full re-dump silently strips every comment in the user's
// real config.yaml (same reasoning as management-client.js's
// patchRoutingStrategy, which this mirrors). Only ever touches the one
// `key: ...` line; everything else is left byte-for-byte untouched. Assumes
// `key` is always written as a single-line scalar (true/false/number),
// which is the case for every key this is used on.
function patchTopLevelScalar(yamlText, key, valueLiteral) {
    const lines = yamlText.split("\n");
    const re = new RegExp(`^${key}:\\s*.*$`);
    const idx = lines.findIndex((l) => re.test(l));
    if (idx === -1) {
        const sep = yamlText.endsWith("\n") ? "" : "\n";
        return `${yamlText}${sep}${key}: ${valueLiteral}\n`;
    }
    lines[idx] = `${key}: ${valueLiteral}`;
    return lines.join("\n");
}

// Same surgical approach as patchTopLevelScalar, but for a top-level string
// array (e.g. `api-keys`) that may currently be written either as an inline
// flow list (`key: ["x"]` / `key: []`) or a block list (`key:` followed by
// indented `- item` lines) -- replaces whichever form is present with a
// fresh flow-style list, without touching anything else in the file.
function patchTopLevelList(yamlText, key, items) {
    const lines = yamlText.split("\n");
    const startRe = new RegExp(`^${key}:\\s*(.*)$`);
    const idx = lines.findIndex((l) => startRe.test(l));
    const newLine = `${key}: ${JSON.stringify(items)}`;
    if (idx === -1) {
        const sep = yamlText.endsWith("\n") ? "" : "\n";
        return `${yamlText}${sep}${newLine}\n`;
    }
    const inlineRemainder = lines[idx].match(startRe)[1].trim();
    let end = idx + 1;
    if (!inlineRemainder) {
        while (end < lines.length && /^\s*-\s/.test(lines[end])) end++;
    }
    lines.splice(idx, end - idx, newLine);
    return lines.join("\n");
}

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

function versionNumber(value) {
    const match = String(value ?? "").match(/v?(\d+\.\d+\.\d+)/i);
    return match ? match[1] : null;
}

function isVersionOlder(installed, latest) {
    if (!installed || !latest) return false;
    const left = installed.split(".").map(Number);
    const right = latest.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0);
    }
    return false;
}

async function getInstalledVersion() {
    const target = binaryPath();
    if (!fs.existsSync(target)) {
        installedVersionCache = null;
        return null;
    }
    const stat = await fsp.stat(target);
    const fingerprint = `${target}:${stat.size}:${stat.mtimeMs}`;
    if (installedVersionCache?.fingerprint === fingerprint) return installedVersionCache.version;
    let version = null;
    try {
        const result = await execFileAsync(target, ["--version"], { windowsHide: true, timeout: 5000 });
        version = versionNumber(`${result.stdout}\n${result.stderr}`);
    } catch (err) {
        // CLIProxyAPI prints its version and then exits non-zero because it does
        // not define a --version flag (the version line is followed by its usage
        // text). Preserve that useful stdout/stderr instead of treating the
        // installed binary as versionless.
        version = versionNumber(`${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    }
    installedVersionCache = { fingerprint, version };
    return version;
}

export async function getVersionStatus() {
    const installedVersion = await getInstalledVersion();
    let latestVersion = null;
    try {
        latestVersion = versionNumber((await getLatestRelease()).tag_name);
    } catch {
        // Version checks are advisory; the server status must remain available
        // when GitHub is unreachable or rate-limits the request.
    }
    return {
        installedVersion,
        latestVersion,
        updateAvailable: Boolean(installedVersion && latestVersion && isVersionOlder(installedVersion, latestVersion)),
    };
}

/**
 * Maps Node's os.platform()/arch() to the naming scheme used by CLIProxyAPI's
 * GitHub releases (e.g. CLIProxyAPI_7.2.51_darwin_aarch64.tar.gz). Note the
 * release assets use "aarch64", not Node's own "arm64" arch string -- getting
 * this wrong silently breaks installs on every ARM64 machine (Apple Silicon
 * Macs, ARM64 Windows/Linux) with "No release asset found for darwin/arm64".
 */
function platformKeywords() {
    const platform = os.platform(); // 'win32' | 'linux' | 'darwin'
    const arch = os.arch(); // 'x64' | 'arm64' | ...
    const osKey = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
    const archKey = arch === "x64" ? "amd64" : arch === "arm64" ? "aarch64" : arch;
    return { osKey, archKey, platform };
}

/**
 * fetch has no default timeout -- a stalled connection (dropped packet,
 * flaky network, an in-flight request the OS never completes) leaves a fetch
 * pending forever. AbortController gives it a hard ceiling instead, but the
 * signal has to stay live through the whole operation `fn` performs
 * (including reading the response body via .json()/.arrayBuffer()) -- an
 * earlier version of this cleared the timer as soon as fetch()'s promise
 * resolved (i.e. once headers arrived), which left body-streaming stalls
 * completely unprotected and still hung indefinitely.
 */
async function withTimeout(timeoutMs, fn) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fn(controller.signal);
    } catch (err) {
        if (err.name === "AbortError") throw new Error(`Timed out after ${timeoutMs}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function getLatestRelease() {
    if (releaseCache && Date.now() - releaseCache.checkedAt < RELEASE_CACHE_MS) return releaseCache.release;
    const tag = settings.cliproxyVersion === "latest" ? "latest" : `tags/${settings.cliproxyVersion}`;
    const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/${tag}`;
    const release = await withTimeout(15_000, async (signal) => {
        const res = await fetch(url, { headers: { "User-Agent": "renn-copilot" }, signal });
        if (!res.ok) throw new Error(`Failed to query GitHub releases (${res.status})`);
        return res.json();
    });
    releaseCache = { checkedAt: Date.now(), release };
    return release;
}

async function fetchLatestReleaseAsset() {
    const release = await getLatestRelease();
    const { osKey, archKey } = platformKeywords();

    // linux/freebsd releases ship both a full build and a "_no-plugin" variant
    // for the same os/arch -- prefer the full one when both match.
    const matches = release.assets.filter((asset) => {
        const name = asset.name.toLowerCase();
        return name.includes(osKey) && name.includes(archKey);
    });
    const candidate = matches.find((asset) => !asset.name.toLowerCase().includes("no-plugin")) ?? matches[0];

    if (!candidate) {
        throw new Error(
            `No release asset found for ${osKey}/${archKey} in ${release.tag_name}. ` +
            `Available assets: ${release.assets.map((a) => a.name).join(", ")}`
        );
    }
    return { url: candidate.browser_download_url, name: candidate.name, version: release.tag_name };
}

async function downloadToFile(url, destPath) {
    // The binary itself is ~45MB -- generous but still bounded, so a truly
    // stalled connection (including one that stalls mid-transfer, after
    // headers already arrived) fails within a couple minutes instead of
    // hanging forever.
    const buffer = await withTimeout(120_000, async (signal) => {
        const res = await fetch(url, { headers: { "User-Agent": "renn-copilot" }, signal });
        if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
        return res.arrayBuffer();
    });
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

    let installError = null;
    try {
        const { name, url, version } = await fetchLatestReleaseAsset();
        pushLog(`Downloading CLIProxyAPI ${version} (${name})...`);

        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cliproxy-dl-"));
        const archivePath = path.join(tmpDir, name);
        await downloadToFile(url, archivePath);

        const isArchive = name.endsWith(".zip") || name.endsWith(".tar.gz") || name.endsWith(".tgz");
        if (name.endsWith(".zip")) {
            await extractZip(archivePath, { dir: tmpDir });
        } else if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
            await tar.x({ file: archivePath, cwd: tmpDir });
        } else {
            // Some releases ship the raw binary with no archive extension.
            await copyFileWithRetry(archivePath, binaryPath());
        }

        // Locate the extracted binary (it may be nested in a subfolder). Only
        // applies to the archive branches above -- the raw-binary branch already
        // placed it directly at binaryPath().
        if (isArchive) {
            const expectedName = process.platform === "win32" ? "cli-proxy-api.exe" : "cli-proxy-api";
            const found = await findFileRecursive(tmpDir, expectedName);
            if (!found) {
                // A missing `found` used to be silently skipped here: the temp dir got
                // cleaned up and this function returned success anyway, with nothing
                // ever copied to binaryPath() -- so a first-ever install looked like
                // it "finished" (after the full download+extract wait) but left no
                // binary at all, and a later update on top of an existing install
                // would silently leave the old binary in place while still reporting
                // success. Surface this as a real, actionable error instead.
                throw new Error(
                    `Downloaded archive "${name}" didn't contain an expected "${expectedName}" file after extraction -- ` +
                    `the release's internal layout may have changed. Nothing was installed; any previous binary is untouched.`
                );
            }
            pushLog("Copying binary into place (can be slow if antivirus is scanning the new file)...");
            await copyFileWithRetry(found, binaryPath());
        }
        if (process.platform !== "win32") {
            await fsp.chmod(binaryPath(), 0o755);
        }

        await fsp.rm(tmpDir, { recursive: true, force: true });
        pushLog(`CLIProxyAPI ${version} installed at ${binaryPath()}`);
        return version;
    } catch (err) {
        installError = err;
        throw err;
    } finally {
        if (wasRunning) {
            pushLog("Restarting CLIProxyAPI after update...");
            try {
                await startServer();
            } catch (restartError) {
                if (!installError) throw restartError;
                pushLog(`CLIProxyAPI restart also failed after the update error: ${restartError.message}`);
            }
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
        // "request-log" alone only controls whether CLIProxyAPI logs requests at
        // all -- its Management API's GET /logs (what the dashboard's Logs page
        // reads) additionally requires this to be on, or it responds
        // {"error":"logging to file disabled"} and the page shows nothing.
        "logging-to-file": true,
        "logs-max-total-size-mb": 100,
        "remote-management": {
            "allow-remote": false,
            "secret-key": managementKey,
        },
        // Starts unauthenticated (matches rennCopilot.requireApiKey's own default
        // of false) rather than baking in `proxyApiKey` as a required key here.
        // A brand-new config used to always require it, and the extension only
        // disables that requirement *after* activating (via PUT /server/proxy-auth,
        // see extension.ts's syncModels) -- on a first-ever install that left a
        // real race: CLIProxyAPI could spawn, and chatLanguageModels.json could
        // get written with no key, before that async fix-up's config.yaml write
        // actually took effect, so the very first chat request 401'd. A later
        // "Reload Window" always looked like it fixed it because by then
        // config.yaml already had api-keys: [] persisted from the first session's
        // fix-up, so the race no longer existed on the next launch. Starting
        // empty here removes the race entirely for the common (default) case;
        // rennCopilot.requireApiKey: true still adds `proxyApiKey` back via that
        // same PUT /server/proxy-auth call shortly after activation.
        "api-keys": [],
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
    settings.proxyApiKey = proxyApiKey;
    saveOwnKeys({ proxyApiKey });

    // A *present but empty* api-keys: [] is a deliberate choice -- the fresh-
    // install default (see ensureDefaultConfig) or a user-toggled
    // rennCopilot.requireApiKey: false via setProxyAuthEnabled -- not a config
    // that predates this feature. Writing a key back in here would silently
    // re-require auth behind the extension's back (this function runs on every
    // startServer() call), reintroducing the exact startup race this default
    // was changed to avoid. Only backfill into config.yaml when the key is
    // genuinely *missing* (an old CLIProxyAPI config from before this feature
    // existed) -- we still cache a key in memory either way, so
    // /models/export has one ready and a later requireApiKey: true can add it
    // back via setProxyAuthEnabled without generating a new one.
    if (doc["api-keys"] !== undefined) return proxyApiKey;

    const patchedText = patchTopLevelList(fs.readFileSync(configPath(), "utf8"), "api-keys", [proxyApiKey]);
    fs.writeFileSync(configPath(), patchedText, "utf8");
    pushLog(`Backfilled a proxy API key into config.yaml (restart CLIProxyAPI to apply).`);
    return proxyApiKey;
}

/**
 * Backfills "logging-to-file" into an existing config.yaml that predates
 * this feature -- without it, CLIProxyAPI's Management API GET /logs (what
 * the dashboard's Logs page reads for the "CLIProxyAPI" tab) returns
 * {"error":"logging to file disabled"} even though request-log is on.
 * Requires a restart to take effect since CLIProxyAPI reads config.yaml at
 * startup for this option (unlike api-keys, which it hot-reloads).
 */
export function ensureLoggingToFile() {
    if (!fs.existsSync(configPath())) return { changed: false };
    let doc;
    try {
        doc = yaml.load(fs.readFileSync(configPath(), "utf8")) || {};
    } catch (err) {
        pushLog(`Warning: could not parse config.yaml (${err.message})`);
        return { changed: false };
    }

    if (doc["logging-to-file"] === true) return { changed: false };

    let patchedText = patchTopLevelScalar(fs.readFileSync(configPath(), "utf8"), "logging-to-file", "true");
    if (doc["logs-max-total-size-mb"] === undefined) {
        patchedText = patchTopLevelScalar(patchedText, "logs-max-total-size-mb", "100");
    }
    fs.writeFileSync(configPath(), patchedText, "utf8");
    pushLog(`Backfilled logging-to-file into config.yaml (restart CLIProxyAPI to apply).`);
    return { changed: true };
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

    const patchedText = patchTopLevelList(fs.readFileSync(configPath(), "utf8"), "api-keys", nextKeys);
    fs.writeFileSync(configPath(), patchedText, "utf8");
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
    ensureLoggingToFile();
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

// --- xAI (Grok) OAuth login -------------------------------------------------
// CLIProxyAPI has no Management API endpoint for xAI OAuth (confirmed against
// help.router-for.me/management/api.html -- only antigravity/claude/codex get
// a GET .../auth-url + GET /get-auth-status pair). xAI login only exists as a
// CLI flag ("-xai-login"), and it's a device-code flow, not the redirect-
// callback flow the other three providers use: run standalone, it prints a
// URL + user code to stdout, polls x.ai's token endpoint itself, and (per
// `-help`'s own description, confirmed live up to the "waiting" stage without
// completing a real grant) exits once authorized. It doesn't bind a local
// callback port, so it's safe to run this as a second, short-lived process
// alongside the already-running persistent server -- they only share the
// auth-dir on disk, not a network port.
const xaiLogins = new Map(); // state -> { status: "wait" | "ok" | "error", error?: string }
const XAI_LOGIN_TIMEOUT_MS = 6 * 60 * 1000; // a bit past the dashboard's own 5-minute poll window
const XAI_LOGIN_URL_RE = /(https:\/\/accounts\.x\.ai\/oauth2\/device\?user_code=\S+)/;
const XAI_LOGIN_CODE_RE = /enter this code:\s*(\S+)/i;

/**
 * Spawns a standalone `-xai-login` process and resolves with the device-flow
 * URL (+ user code) as soon as it's printed, so routes.js can hand it back to
 * the dashboard the same way it does for the Management-API-driven providers'
 * auth URL. The process keeps running in the background afterward, polling
 * x.ai for authorization -- its outcome is tracked in `xaiLogins` under the
 * same `state` and surfaced via getXaiLoginStatus() for the dashboard's
 * existing poll loop.
 */
export function startXaiLogin() {
    return new Promise((resolve, reject) => {
        const state = crypto.randomUUID();
        const child = spawn(binaryPath(), ["-config", configPath(), "-xai-login", "-no-browser"], {
            cwd: settings.cliproxyHome,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const entry = { status: "wait" };
        xaiLogins.set(state, entry);

        let buffered = "";
        let urlResolved = false;

        function onOutput(text) {
            buffered += text;
            if (urlResolved) return;
            const urlMatch = buffered.match(XAI_LOGIN_URL_RE);
            if (urlMatch) {
                urlResolved = true;
                const codeMatch = buffered.match(XAI_LOGIN_CODE_RE);
                resolve({ url: urlMatch[1], userCode: codeMatch?.[1], state });
            }
        }

        child.stdout.on("data", (chunk) => {
            const text = chunk.toString();
            pushLog(`[xai-login] ${text.trim()}`);
            onOutput(text);
        });
        child.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            pushLog(`[xai-login stderr] ${text.trim()}`);
            onOutput(text);
        });

        child.on("exit", (code) => {
            clearTimeout(safetyTimer);
            if (code === 0) {
                entry.status = "ok";
                // The standalone login process wrote the new auth file to disk, but
                // the already-running server only reads auth-dir at startup -- it
                // won't see the new xAI credential in GET /auth-files until it
                // restarts. Restart automatically so this behaves like every other
                // provider's login from the dashboard's point of view.
                if (isRunning()) {
                    restartServer().catch((err) => pushLog(`xAI login: restart after login failed: ${err.message}`));
                }
            } else {
                entry.status = "error";
                entry.error = `xAI login exited with code ${code}` + (buffered.trim() ? `: ${buffered.trim().split("\n").pop()}` : "");
            }
            if (!urlResolved) {
                urlResolved = true;
                reject(new Error(entry.status === "error" ? entry.error : "xAI login process ended before printing a login URL"));
            }
            // Keep the final status around briefly so a last in-flight poll can see it.
            setTimeout(() => xaiLogins.delete(state), 5 * 60 * 1000);
        });

        const safetyTimer = setTimeout(() => {
            if (entry.status === "wait") {
                entry.status = "error";
                entry.error = "xAI login timed out waiting for authorization";
                try {
                    child.kill();
                } catch {
                    // already exited
                }
            }
        }, XAI_LOGIN_TIMEOUT_MS);
    });
}

export function getXaiLoginStatus(state) {
    const entry = xaiLogins.get(state);
    if (!entry) return { status: "error", error: "Unknown or expired xAI login attempt" };
    return { status: entry.status, error: entry.error };
}
