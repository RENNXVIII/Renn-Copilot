// Extension-host manager for the RTK integration.
//
// This owns every side-effecting RTK operation: resolving/validating an `rtk`
// binary, downloading + checksum-verifying + safely extracting a managed
// binary, making it resolvable on PATH, and running the official Copilot
// `rtk init`/`rtk gain` commands. RTK is never modeled as a daemon -- there is
// no start/stop/port/health state here.
//
// All logic that can be reasoned about without real I/O lives in RtkManagerCore
// and receives its filesystem/process/download/env behavior through injected
// adapters, so src/test/rtk-manager.test.ts can exercise it under `node --test`
// with fakes. The real adapters (backed by node:fs, node:child_process, and
// GitHub Releases) and a VS Code factory live at the bottom of this file.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import https from "node:https";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import extractZip from "extract-zip";
import * as tar from "tar";
import type * as vscode from "vscode";

import {
  RTK_GITHUB_REPO,
  RtkScope,
  RtkOperation,
  RtkGainSummary,
  rtkAssetFor,
  rtkBinaryName,
  rtkArgs,
  parseRtkVersion,
  parseChecksumFile,
  isSafeArchiveEntry,
  parseRtkGain,
  isVersionOlder,
} from "./rtk-core";

const execFileAsync = promisify(execFile);

const PROCESS_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000; // 1 MB stdout/stderr cap.
const NETWORK_TIMEOUT_MS = 30_000;

// ── Adapter interfaces (the test seam) ──────────────────────────────────────

/** Result of running a child process. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Everything RtkManagerCore needs from the outside world. Real implementations
 * touch the OS; test implementations are in-memory fakes.
 */
export interface RtkAdapters {
  platform: NodeJS.Platform;
  arch: string;
  /** OS home directory (for ~/.local/bin and ~/.copilot resolution). */
  homeDir: string;
  /** Directory where the managed binary + manifest are stored (globalStorage). */
  storageDir: string;
  /** Current PATH entries as seen by the extension host process. */
  pathEntries: string[];
  /** Runs an executable with a fixed argument array. Never uses a shell. */
  run(file: string, args: string[], cwd?: string): Promise<RunResult>;
  /** Finds an `rtk`/`rtk.exe` on PATH, returning its absolute path or null. */
  which(binaryName: string): Promise<string | null>;
  /** Downloads a URL to a local file. */
  download(url: string, destPath: string): Promise<void>;
  /** Fetches text (release JSON / checksums.txt). */
  fetchText(url: string): Promise<string>;
  /** Extracts an archive into a directory, rejecting unsafe entries. */
  extract(archivePath: string, kind: "zip" | "tar.gz", destDir: string): Promise<void>;
  /** Adds a directory to the persistent user PATH. Returns true if it changed. */
  addToUserPath(dir: string): Promise<boolean>;
  /** Removes a directory from the persistent user PATH. Returns true if it changed. */
  removeFromUserPath(dir: string): Promise<boolean>;
  /** Copies/updates the compatibility bridge at its stable managed location. */
  prepareHookBridge(): Promise<void>;
  /** Builds the shell command used by the Copilot hook compatibility bridge. */
  hookCommand(binaryPath: string): string;
}

// ── Status types (surfaced to the webview) ──────────────────────────────────

export type RtkBinarySource = "path" | "managed";

export interface RtkBinaryInfo {
  source: RtkBinarySource;
  path: string;
  version: string;
  /** Whether the resolved binary will be found when Copilot runs `rtk`. */
  pathReady: boolean;
}

export interface RtkStatus {
  platformSupported: boolean;
  binary: RtkBinaryInfo | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Present when a different, non-rtk-ai `rtk` shadows the PATH. */
  conflictPath: string | null;
  /** True on Windows once a managed dir was added to PATH but the host env hasn't picked it up. */
  restartRequired: boolean;
  workspace: RtkScopeStatus;
  global: RtkScopeStatus;
  warning: string | null;
}

export interface RtkScopeStatus {
  configured: boolean;
  hookPath: string | null;
  instructionsPath: string | null;
  /**
   * True when the hook invokes the managed binary by absolute path, so Copilot
   * can run RTK without `rtk` being resolvable on PATH.
   */
  hookPinned: boolean;
}

/** Small on-disk record of what Renn installed/owns, so removal is safe. */
interface RtkManifest {
  version: string;
  assetFileName: string;
  sha256: string;
  binaryPath: string;
  /** Whether Renn added the managed dir to the user PATH (Windows). */
  addedToUserPath: boolean;
  /** Whether Renn created the ~/.local/bin/rtk symlink (macOS/Linux). */
  createdSymlink: boolean;
}

/** Raw GitHub release shape (only the fields we read). */
interface GithubRelease {
  tag_name: string;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

// ── Core (no vscode, no direct I/O) ─────────────────────────────────────────

export class RtkManagerCore {
  /** Serializes mutating operations so concurrent clicks can't race. */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly a: RtkAdapters) {}

  private get managedBinDir(): string {
    // A stable, versioned-independent active-binary dir. On Windows this is the
    // directory we add to PATH; on POSIX the ~/.local/bin symlink points here.
    return path.join(this.a.storageDir, "bin");
  }

  private get managedBinaryPath(): string {
    return path.join(this.managedBinDir, rtkBinaryName(this.a.platform));
  }

  private get manifestPath(): string {
    return path.join(this.a.storageDir, "rtk-manifest.json");
  }

  private get localBinSymlink(): string {
    return path.join(this.a.homeDir, ".local", "bin", "rtk");
  }

  /** Runs any mutating operation through the serialization chain. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn);
    // Keep the chain alive even if fn rejects, but don't leak the rejection.
    this.mutationChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async runRtk(binaryPath: string, args: string[], cwd?: string): Promise<RunResult> {
    return this.a.run(binaryPath, args, cwd);
  }

  /**
   * Confirms an executable is really `rtk-ai/rtk` (not the unrelated "Rust
   * Type Kit" that also ships an `rtk` binary) by requiring both a parseable
   * `--version` and a valid `gain --format json` payload.
   */
  private async validateRtkBinary(binaryPath: string): Promise<string | null> {
    let version: string | null = null;
    try {
      const v = await this.runRtk(binaryPath, ["--version"]);
      version = parseRtkVersion(`${v.stdout}\n${v.stderr}`);
    } catch {
      return null;
    }
    if (!version) return null;
    try {
      const g = await this.runRtk(binaryPath, ["gain", "--format", "json"]);
      parseRtkGain(JSON.parse(g.stdout));
    } catch {
      return null;
    }
    return version;
  }

  private async readManifest(): Promise<RtkManifest | null> {
    try {
      const raw = await fsp.readFile(this.manifestPath, "utf8");
      return JSON.parse(raw) as RtkManifest;
    } catch {
      return null;
    }
  }

  private async writeManifest(manifest: RtkManifest): Promise<void> {
    await fsp.mkdir(path.dirname(this.manifestPath), { recursive: true });
    await fsp.writeFile(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  /** Whether the managed bin dir is resolvable on the current PATH. */
  private managedDirOnPath(): boolean {
    const target = path.resolve(this.managedBinDir);
    return this.a.pathEntries.some((entry) => path.resolve(entry) === target);
  }

  private localBinDirOnPath(): boolean {
    const target = path.resolve(path.join(this.a.homeDir, ".local", "bin"));
    return this.a.pathEntries.some((entry) => path.resolve(entry) === target);
  }

  /**
   * Resolves the active RTK binary, preferring a validated PATH binary, then a
   * validated managed binary. Detects a same-named but wrong-distribution
   * binary on PATH as a conflict.
   */
  async resolveBinary(): Promise<{ info: RtkBinaryInfo | null; conflictPath: string | null }> {
    const binaryName = rtkBinaryName(this.a.platform);

    // 1. Validated PATH binary.
    const pathBinary = await this.a.which(binaryName);
    if (pathBinary) {
      const version = await this.validateRtkBinary(pathBinary);
      if (version) {
        // After VS Code restarts, the Renn-managed bin directory is visible on
        // PATH and `which` resolves the managed binary itself. Preserve its
        // ownership here; otherwise ensureBinary() treats it as user-owned and
        // returns early, making the "Update binary" button a no-op.
        const manifest = await this.readManifest();
        const isManaged =
          !!manifest && path.resolve(pathBinary).toLowerCase() === path.resolve(manifest.binaryPath).toLowerCase();
        return {
          info: { source: isManaged ? "managed" : "path", path: pathBinary, version, pathReady: true },
          conflictPath: null,
        };
      }
      // Same name, wrong distribution.
      const managed = await this.resolveManaged();
      return { info: managed, conflictPath: pathBinary };
    }

    // 2. Managed binary.
    const managed = await this.resolveManaged();
    return { info: managed, conflictPath: null };
  }

  private async resolveManaged(): Promise<RtkBinaryInfo | null> {
    const manifest = await this.readManifest();
    if (!manifest) return null;
    if (!fs.existsSync(manifest.binaryPath)) return null;
    const pathReady =
      this.a.platform === "win32" ? this.managedDirOnPath() : this.localBinDirOnPath();
    return { source: "managed", path: manifest.binaryPath, version: manifest.version, pathReady };
  }

  private copilotHome(): string {
    const envHome = process.env.COPILOT_HOME;
    if (envHome && envHome.trim()) return envHome;
    return path.join(this.a.homeDir, ".copilot");
  }

  private scopeStatus(scope: RtkScope, workspaceDir?: string): RtkScopeStatus {
    if (scope === "global") {
      const home = this.copilotHome();
      const hookPath = path.join(home, "hooks", "rtk-rewrite.json");
      const instructionsPath = path.join(home, "copilot-instructions.md");
      const configured = fs.existsSync(hookPath);
      return { configured, hookPath, instructionsPath, hookPinned: configured && this.isHookPinned(hookPath) };
    }
    if (!workspaceDir) {
      return { configured: false, hookPath: null, instructionsPath: null, hookPinned: false };
    }
    const hookPath = path.join(workspaceDir, ".github", "hooks", "rtk-rewrite.json");
    const instructionsPath = path.join(workspaceDir, ".github", "copilot-instructions.md");
    const configured = fs.existsSync(hookPath);
    return { configured, hookPath, instructionsPath, hookPinned: configured && this.isHookPinned(hookPath) };
  }

  /** Whether the hook file at `hookPath` invokes an absolute-path binary (not bare `rtk`). */
  private isHookPinned(hookPath: string): boolean {
    try {
      const raw = fs.readFileSync(hookPath, "utf8");
      // A pinned hook never starts a command with the bare token `rtk`.
      const commands = [...raw.matchAll(/"(?:command|bash|powershell)"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
      if (commands.length === 0) return false;
      return commands.every((c) => !/^\s*rtk(\.exe)?(\s|$)/i.test(c));
    } catch {
      return false;
    }
  }

  /** Fetches the latest non-prerelease version from GitHub, or null when offline. */
  async getLatestVersion(): Promise<string | null> {
    try {
      const raw = await this.a.fetchText(`https://api.github.com/repos/${RTK_GITHUB_REPO}/releases/latest`);
      const release = JSON.parse(raw) as GithubRelease;
      return parseRtkVersion(release.tag_name);
    } catch {
      return null;
    }
  }

  async getStatus(workspaceDir?: string): Promise<RtkStatus> {
    const asset = rtkAssetFor(this.a.platform, this.a.arch);
    if (!asset) {
      return {
        platformSupported: false,
        binary: null,
        latestVersion: null,
        updateAvailable: false,
        conflictPath: null,
        restartRequired: false,
        workspace: this.scopeStatus("workspace", workspaceDir),
        global: this.scopeStatus("global"),
        warning: `No official RTK release is available for ${this.a.platform}/${this.a.arch}.`,
      };
    }

    const { info, conflictPath } = await this.resolveBinary();
    const latestVersion = await this.getLatestVersion();
    // Renn can only replace binaries it owns. A user/package-manager binary on
    // PATH may be outdated, but advertising an update here would make the
    // button a no-op because ensureBinary() intentionally leaves it untouched.
    const updateAvailable = info?.source === "managed" && !!latestVersion && isVersionOlder(info.version, latestVersion);
    const workspace = this.scopeStatus("workspace", workspaceDir);
    const global = this.scopeStatus("global");

    // A pinned hook calls the binary by absolute path, so Copilot works without
    // the binary being on PATH -- no restart needed even if `pathReady` is false.
    const anyPinned = workspace.hookPinned || global.hookPinned;
    const restartRequired = !!info && info.source === "managed" && !info.pathReady && !anyPinned;

    let warning: string | null = null;
    if (conflictPath) {
      warning = `A different executable named "rtk" was found on PATH at ${conflictPath}. Renn will not modify it.`;
    } else if (restartRequired && this.a.platform === "win32") {
      warning = "The managed RTK was installed but is not yet on this session's PATH. Restart VS Code so Copilot can find it.";
    } else if (restartRequired) {
      warning = "The managed RTK is installed but ~/.local/bin is not on PATH, so Copilot may not find it.";
    }

    return {
      platformSupported: true,
      binary: info,
      latestVersion,
      updateAvailable,
      conflictPath,
      restartRequired,
      workspace,
      global,
      warning,
    };
  }

  /**
   * Ensures a usable RTK binary exists, installing/updating the managed binary
   * when no valid PATH binary is present. Never overwrites a user-owned binary.
   */
  async ensureBinary(): Promise<RtkBinaryInfo> {
    return this.serialize(async () => {
      const { info } = await this.resolveBinary();
      if (info && info.source === "path") return info;

      const latest = await this.getLatestVersion();
      const manifest = await this.readManifest();
      const needsInstall =
        !manifest || !fs.existsSync(manifest.binaryPath) || (!!latest && isVersionOlder(manifest.version, latest));
      if (needsInstall) {
        await this.installManaged();
      }
      const managed = await this.resolveManaged();
      if (!managed) throw new Error("Failed to install the managed RTK binary.");
      return managed;
    });
  }

  /**
   * Downloads, checksum-verifies, safely extracts, and atomically activates the
   * latest managed RTK binary. A failure at any step leaves the current active
   * binary untouched.
   */
  private async installManaged(): Promise<void> {
    const asset = rtkAssetFor(this.a.platform, this.a.arch);
    if (!asset) throw new Error(`Unsupported platform ${this.a.platform}/${this.a.arch}.`);

    const releaseRaw = await this.a.fetchText(
      `https://api.github.com/repos/${RTK_GITHUB_REPO}/releases/latest`
    );
    const release = JSON.parse(releaseRaw) as GithubRelease;
    const version = parseRtkVersion(release.tag_name);
    if (!version) throw new Error("Could not determine the latest RTK version.");

    const assetEntry = release.assets.find((x) => x.name === asset.fileName);
    if (!assetEntry) throw new Error(`Release is missing asset ${asset.fileName}.`);
    const checksumsEntry = release.assets.find((x) => x.name === "checksums.txt");
    if (!checksumsEntry) throw new Error("Release is missing checksums.txt.");

    const checksumsText = await this.a.fetchText(checksumsEntry.browser_download_url);
    const checksums = parseChecksumFile(checksumsText);
    const expected = checksums.get(asset.fileName);
    if (!expected) throw new Error(`checksums.txt has no entry for ${asset.fileName}.`);

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "renn-rtk-"));
    try {
      const archivePath = path.join(tmpRoot, asset.fileName);
      await this.a.download(assetEntry.browser_download_url, archivePath);

      const actual = await sha256File(archivePath);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${asset.fileName}.`);
      }

      const extractDir = path.join(tmpRoot, "extracted");
      await fsp.mkdir(extractDir, { recursive: true });
      await this.a.extract(archivePath, asset.kind, extractDir);

      const binaryName = rtkBinaryName(this.a.platform);
      const extractedBinary = await findFileRecursive(extractDir, binaryName);
      if (!extractedBinary) throw new Error(`Extracted archive did not contain ${binaryName}.`);
      if (this.a.platform !== "win32") await fsp.chmod(extractedBinary, 0o755);

      // Validate before activating.
      const validVersion = await this.validateRtkBinary(extractedBinary);
      if (!validVersion) throw new Error("Downloaded RTK binary failed validation.");

      // Activate atomically into the managed bin dir.
      await fsp.mkdir(this.managedBinDir, { recursive: true });
      const finalBinary = this.managedBinaryPath;
      const stagingBinary = `${finalBinary}.new`;
      await fsp.copyFile(extractedBinary, stagingBinary);
      if (this.a.platform !== "win32") await fsp.chmod(stagingBinary, 0o755);
      await replaceFile(stagingBinary, finalBinary);

      const prev = await this.readManifest();
      await this.writeManifest({
        version: validVersion,
        assetFileName: asset.fileName,
        sha256: expected,
        binaryPath: finalBinary,
        addedToUserPath: prev?.addedToUserPath ?? false,
        createdSymlink: prev?.createdSymlink ?? false,
      });
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  }

  /**
   * Makes the managed binary resolvable for Copilot's `rtk hook copilot` call.
   * Windows: adds the managed dir to the user PATH. POSIX: creates a Renn-owned
   * ~/.local/bin/rtk symlink (never overwriting an existing non-Renn target).
   * Returns whether a VS Code restart is required to pick up the change.
   */
  async ensureManagedOnPath(): Promise<{ restartRequired: boolean }> {
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      if (!manifest) throw new Error("No managed RTK binary is installed.");

      if (this.a.platform === "win32") {
        const alreadyOnPath = this.managedDirOnPath();
        // Always (re)apply the persistent PATH entry unless it's already there.
        // addToUserPath is idempotent and returns true only once the managed dir
        // is actually present in the registry PATH, so we never record a false
        // success -- this self-heals a stale `addedToUserPath: true` left behind
        // by an earlier `setx` truncation on long PATHs.
        const persisted = await this.a.addToUserPath(this.managedBinDir);
        if (persisted !== manifest.addedToUserPath) {
          await this.writeManifest({ ...manifest, addedToUserPath: persisted });
        }
        return { restartRequired: persisted && !alreadyOnPath };
      }

      // POSIX symlink into ~/.local/bin.
      const linkDir = path.dirname(this.localBinSymlink);
      await fsp.mkdir(linkDir, { recursive: true });
      const existing = await readlinkSafe(this.localBinSymlink);
      if (existing === null && fs.existsSync(this.localBinSymlink)) {
        // A non-symlink file we don't own -- don't clobber it.
        throw new Error(`${this.localBinSymlink} already exists and is not managed by Renn.`);
      }
      if (existing !== manifest.binaryPath) {
        if (existing !== null) await fsp.rm(this.localBinSymlink, { force: true });
        await fsp.symlink(manifest.binaryPath, this.localBinSymlink);
        await this.writeManifest({ ...manifest, createdSymlink: true });
      }
      return { restartRequired: !this.localBinDirOnPath() };
    });
  }

  /** Runs an official RTK operation for a scope, using the resolved binary. */
  private async runOperation(
    operation: RtkOperation,
    scope: RtkScope,
    workspaceDir?: string
  ): Promise<RunResult> {
    const { info } = await this.resolveBinary();
    if (!info) throw new Error("No RTK binary is available.");
    const cwd = scope === "workspace" ? workspaceDir : undefined;
    if (scope === "workspace" && !cwd) throw new Error("A workspace folder is required.");
    return this.runRtk(info.path, rtkArgs(operation, scope), cwd);
  }

  async setup(scope: RtkScope, workspaceDir?: string): Promise<void> {
    return this.serialize(async () => {
      const result = await this.runOperation("setup", scope, workspaceDir);
      if (result.exitCode !== 0) {
        throw new Error(`rtk init failed: ${result.stderr || result.stdout}`.trim());
      }
      // Route the generated hook through Renn's compatibility bridge. Current
      // VS Code builds call the terminal tool `run_in_terminal`, which RTK 0.43
      // does not recognize. The bridge translates that name and pins rewritten
      // commands to this exact binary, avoiding PATH/restart dependencies.
      const { info } = await this.resolveBinary();
      if (info) {
        await this.a.prepareHookBridge();
        await this.installHookBridge(scope, info.path, workspaceDir);
      }
    });
  }

  /**
   * Rewrites the RTK-generated hook file so every `rtk ...` invocation uses the
   * managed binary's absolute path instead of the bare `rtk` command. This is
   * idempotent and only touches the leading `rtk` token of each command string.
   */
  private async installHookBridge(scope: RtkScope, binaryPath: string, workspaceDir?: string): Promise<void> {
    const { hookPath } = this.scopeStatus(scope, workspaceDir);
    if (!hookPath) return;
    let raw: string;
    try {
      raw = await fsp.readFile(hookPath, "utf8");
    } catch {
      return;
    }
    let hook: unknown;
    try {
      hook = JSON.parse(raw);
    } catch {
      return;
    }
    const bridgeCommand = this.a.hookCommand(binaryPath);
    let changed = false;
    const rewriteCommand = (value: unknown): unknown => {
      if (typeof value !== "string") return value;
      // Replace only RTK's generated hook invocation. Other hooks sharing this
      // JSON structure are left untouched.
      const next = /(?:^|[\\/"'])rtk(?:\.exe)?\s+hook\s+copilot\s*$/i.test(value.trim())
        ? bridgeCommand
        : value;
      if (next !== value) changed = true;
      return next;
    };
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
      } else if (node && typeof node === "object") {
        const obj = node as Record<string, unknown>;
        for (const key of ["command", "bash", "powershell"]) {
          if (key in obj) obj[key] = rewriteCommand(obj[key]);
        }
        for (const v of Object.values(obj)) visit(v);
      }
    };
    visit(hook);
    if (changed) {
      await fsp.writeFile(hookPath, JSON.stringify(hook, null, 2), "utf8");
    }
  }

  async uninstall(scope: RtkScope, workspaceDir?: string): Promise<void> {
    return this.serialize(async () => {
      // If the binary was deleted while a hook is still configured, `rtk` can't
      // run its own uninstall. Fall back to removing the hook file directly so
      // the scope can always be disabled and returned to a clean state.
      const { info } = await this.resolveBinary();
      if (!info) {
        const { hookPath } = this.scopeStatus(scope, workspaceDir);
        if (hookPath) await fsp.rm(hookPath, { force: true });
        return;
      }
      const result = await this.runOperation("uninstall", scope, workspaceDir);
      if (result.exitCode !== 0) {
        throw new Error(`rtk uninstall failed: ${result.stderr || result.stdout}`.trim());
      }
    });
  }

  async getGain(scope: RtkScope, workspaceDir?: string): Promise<RtkGainSummary> {
    const result = await this.runOperation("gain", scope, workspaceDir);
    if (result.exitCode !== 0) {
      throw new Error(`rtk gain failed: ${result.stderr || result.stdout}`.trim());
    }
    return parseRtkGain(JSON.parse(result.stdout));
  }

  /**
   * Removes only Renn-owned managed artifacts: the managed binary, the
   * Renn-created symlink, the PATH entry Renn added, and the manifest. Never
   * touches a user-owned/package-manager `rtk`.
   */
  async removeManaged(): Promise<void> {
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      if (!manifest) return;
      if (manifest.createdSymlink) {
        const existing = await readlinkSafe(this.localBinSymlink);
        if (existing === manifest.binaryPath) {
          await fsp.rm(this.localBinSymlink, { force: true });
        }
      }
      if (manifest.addedToUserPath) {
        await this.a.removeFromUserPath(this.managedBinDir);
      }
      await fsp.rm(this.managedBinDir, { recursive: true, force: true });
      await fsp.rm(this.manifestPath, { force: true });
    });
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex").toLowerCase();
}

async function readlinkSafe(linkPath: string): Promise<string | null> {
  try {
    return await fsp.readlink(linkPath);
  } catch {
    return null;
  }
}

async function findFileRecursive(dir: string, fileName: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return null;
}

/**
 * Replaces an active file without relying on POSIX rename-overwrite semantics.
 * Windows rejects rename(new, existing), so keep a temporary backup and
 * restore it if activation fails.
 */
async function replaceFile(stagingPath: string, finalPath: string): Promise<void> {
  // Use a unique backup name. Antivirus/indexing processes on Windows can keep
  // a previously activated .exe backup open briefly; a fixed `.old` path then
  // makes every later update fail before activation even starts.
  const backupPath = `${finalPath}.old-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const hadExisting = fs.existsSync(finalPath);
  if (hadExisting) await fsp.rename(finalPath, backupPath);
  try {
    await fsp.rename(stagingPath, finalPath);
  } catch (err) {
    if (hadExisting && !fs.existsSync(finalPath)) {
      await fsp.rename(backupPath, finalPath).catch(() => undefined);
    }
    throw err;
  }

  // Activation already succeeded. Failure to delete a locked backup must not
  // report the whole update as failed or prevent the manifest from advancing.
  if (hadExisting) await fsp.rm(backupPath, { force: true }).catch(() => undefined);
}

// ── Real adapters ───────────────────────────────────────────────────────────

function realRun(file: string, args: string[], cwd?: string): Promise<RunResult> {
  return execFileAsync(file, args, {
    cwd,
    windowsHide: true,
    timeout: PROCESS_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  })
    .then((r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: 0 }))
    .catch((err: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string }) => {
      // execFile rejects on non-zero exit; surface the captured output/code.
      if (err.stdout !== undefined || err.stderr !== undefined) {
        const code = typeof err.code === "number" ? err.code : 1;
        return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: code };
      }
      throw err;
    });
}

async function realWhich(binaryName: string): Promise<string | null> {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathEntries) {
    const candidate = path.join(dir, binaryName);
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function realFetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "renn-copilot", Accept: "application/vnd.github+json" }, timeout: NETWORK_TIMEOUT_MS },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          realFetchText(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
          return;
        }
        let body = "";
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_OUTPUT_BYTES * 10) {
            req.destroy();
            reject(new Error("Response too large."));
            return;
          }
          body += chunk;
        });
        res.on("end", () => resolve(body));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out.")));
    req.on("error", reject);
  });
}

function realDownload(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(
      url,
      { headers: { "User-Agent": "renn-copilot" }, timeout: NETWORK_TIMEOUT_MS },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          file.close();
          realDownload(res.headers.location, destPath).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          file.close();
          reject(new Error(`GET ${url} -> ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
      }
    );
    req.on("timeout", () => req.destroy(new Error("Download timed out.")));
    req.on("error", (err) => {
      file.close();
      reject(err);
    });
  });
}

async function realExtract(archivePath: string, kind: "zip" | "tar.gz", destDir: string): Promise<void> {
  if (kind === "zip") {
    await extractZip(archivePath, {
      dir: destDir,
      onEntry: (entry) => {
        if (!isSafeArchiveEntry(entry.fileName)) {
          throw new Error(`Unsafe archive entry: ${entry.fileName}`);
        }
      },
    });
    return;
  }
  await tar.x({
    file: archivePath,
    cwd: destDir,
    filter: (entryPath) => {
      if (!isSafeArchiveEntry(entryPath)) throw new Error(`Unsafe archive entry: ${entryPath}`);
      return true;
    },
  });
}

/**
 * Reads the raw HKCU\Environment Path value and its registry kind.
 *
 * `reg query` prints `Path    REG_EXPAND_SZ    <value>` (or `REG_SZ`). We keep
 * the kind so we can write the value back with the *same* type -- rewriting an
 * expandable `%USERPROFILE%`-style PATH as a plain string would break other
 * entries.
 */
async function readUserPathRegistry(): Promise<{ value: string; kind: "REG_SZ" | "REG_EXPAND_SZ" }> {
  const current = await execFileAsync("reg", ["query", "HKCU\\Environment", "/v", "Path"], {
    windowsHide: true,
  }).catch(() => null);
  const match = current?.stdout.match(/Path\s+(REG_EXPAND_SZ|REG_SZ)\s+(.*)/i);
  const kind = (match?.[1]?.toUpperCase() as "REG_SZ" | "REG_EXPAND_SZ") ?? "REG_EXPAND_SZ";
  const value = match?.[2]?.trim() ?? "";
  return { value, kind };
}

/**
 * Writes the user PATH directly via `reg add`, preserving the existing value's
 * registry kind. Unlike `setx`, this has no ~1024-char truncation limit, so it
 * is safe for already-long PATHs. Verifies the write landed before returning.
 */
async function writeUserPathRegistry(value: string, kind: "REG_SZ" | "REG_EXPAND_SZ"): Promise<void> {
  await execFileAsync(
    "reg",
    ["add", "HKCU\\Environment", "/v", "Path", "/t", kind, "/d", value, "/f"],
    { windowsHide: true }
  );
}

async function realAddToUserPath(dir: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const { value: existing, kind } = await readUserPathRegistry();
  const entries = existing.split(";").filter(Boolean);
  if (entries.some((e) => path.resolve(e) === path.resolve(dir))) return true;
  const next = existing ? `${existing};${dir}` : dir;
  await writeUserPathRegistry(next, kind);
  // Confirm the write actually landed (guards against a silent registry failure).
  const { value: after } = await readUserPathRegistry();
  return after.split(";").some((e) => e && path.resolve(e) === path.resolve(dir));
}

async function realRemoveFromUserPath(dir: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const { value: existing, kind } = await readUserPathRegistry();
  const entries = existing.split(";").filter(Boolean);
  const filtered = entries.filter((e) => path.resolve(e) !== path.resolve(dir));
  if (filtered.length === entries.length) return false;
  await writeUserPathRegistry(filtered.join(";"), kind);
  return true;
}

/** Builds an RtkManagerCore wired to real OS adapters for the given storage dir. */
export function createRtkManager(context: vscode.ExtensionContext): RtkManagerCore {
  const storageDir = context.globalStorageUri.fsPath;
  const bundledHookBridgePath = path.join(__dirname, "rtk-hook.js");
  const managedHookBridgePath = path.join(storageDir, "rtk-hook.js");
  const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const quotePosix = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
  return new RtkManagerCore({
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
    storageDir,
    pathEntries: (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    run: realRun,
    which: realWhich,
    download: realDownload,
    fetchText: realFetchText,
    extract: realExtract,
    addToUserPath: realAddToUserPath,
    removeFromUserPath: realRemoveFromUserPath,
    prepareHookBridge: async () => {
      await fsp.mkdir(storageDir, { recursive: true });
      await fsp.copyFile(bundledHookBridgePath, managedHookBridgePath);
    },
    hookCommand: (binaryPath) => {
      if (process.platform === "win32") {
        const script = `$env:ELECTRON_RUN_AS_NODE='1'; & ${quotePowerShell(process.execPath)} ${quotePowerShell(managedHookBridgePath)} ${quotePowerShell(binaryPath)}`;
        return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotePowerShell(script)}`;
      }
      return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quotePosix(process.execPath)} ${quotePosix(managedHookBridgePath)} ${quotePosix(binaryPath)}`;
    },
  });
}
