// Tests for RtkManagerCore. These exercise the real filesystem manifest/extract
// logic against a temp storage dir, while faking process execution, PATH
// lookup, and network access through injected adapters. No vscode, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";

import { RtkManagerCore, RtkAdapters, RunResult } from "../rtk-manager.js";
import { rtkBinaryName } from "../rtk-core.js";

// Creating symlinks on Windows requires elevated privilege; skip the POSIX
// symlink-path tests there. The logic itself is platform-agnostic.
const canSymlink = process.platform !== "win32";

const VALID_GAIN = JSON.stringify({
  summary: {
    total_commands: 0,
    total_input: 0,
    total_output: 0,
    total_saved: 0,
    avg_savings_pct: 0,
    total_time_ms: 0,
    avg_time_ms: 0,
  },
  daily: [],
  weekly: [],
  monthly: [],
});

interface Recorder {
  runs: { file: string; args: string[]; cwd?: string }[];
  addedPaths: string[];
  removedPaths: string[];
}

interface FakeConfig {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Path returned by which(), or null when nothing is on PATH. */
  whichResult?: string | null;
  /** Overrides how a given binary path responds to run(). */
  runHandler?: (file: string, args: string[], cwd?: string) => RunResult;
  pathEntries?: string[];
  /** Latest version reported by GitHub releases. */
  latestVersion?: string;
  /** sha256 the download's content will hash to; defaults to the correct one. */
  corruptDownload?: boolean;
  /** Make the extracted binary fail validation. */
  invalidExtractedBinary?: boolean;
}

async function makeManager(cfg: FakeConfig = {}): Promise<{
  core: RtkManagerCore;
  rec: Recorder;
  storageDir: string;
  homeDir: string;
  adapters: RtkAdapters;
}> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rtk-test-"));
  const storageDir = path.join(root, "storage");
  const homeDir = path.join(root, "home");
  await fsp.mkdir(storageDir, { recursive: true });
  await fsp.mkdir(homeDir, { recursive: true });

  const platform = cfg.platform ?? "linux";
  const arch = cfg.arch ?? "x64";
  const latestVersion = cfg.latestVersion ?? "1.2.3";
  const binaryName = rtkBinaryName(platform);
  const rec: Recorder = { runs: [], addedPaths: [], removedPaths: [] };

  // The bytes the fake download writes; sha256 of this is the "correct" digest.
  const assetBytes = Buffer.from("rtk-binary-payload");
  const correctSha = crypto.createHash("sha256").update(assetBytes).digest("hex");

  const assetName =
    platform === "win32"
      ? "rtk-x86_64-pc-windows-msvc.zip"
      : arch === "arm64"
      ? "rtk-aarch64-unknown-linux-gnu.tar.gz"
      : "rtk-x86_64-unknown-linux-musl.tar.gz";

  const defaultRun = (_file: string, args: string[]): RunResult => {
    if (args[0] === "--version") return { stdout: `rtk ${latestVersion}`, stderr: "", exitCode: 0 };
    if (args[0] === "gain" && args.includes("--format")) {
      return { stdout: VALID_GAIN, stderr: "", exitCode: 0 };
    }
    if (args[0] === "init") return { stdout: "ok", stderr: "", exitCode: 0 };
    if (args[0] === "gain") return { stdout: VALID_GAIN, stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "unknown", exitCode: 1 };
  };

  const adapters: RtkAdapters = {
    platform,
    arch,
    homeDir,
    storageDir,
    pathEntries: cfg.pathEntries ?? [],
    async run(file, args, cwd) {
      rec.runs.push({ file, args, cwd });
      // A freshly downloaded/managed binary that must fail validation: any
      // version probe against a non-PATH binary reports a non-rtk string.
      const isPathBinary = cfg.whichResult && file === cfg.whichResult;
      if (cfg.invalidExtractedBinary && !isPathBinary && args[0] === "--version") {
        return { stdout: "not-rtk", stderr: "", exitCode: 0 };
      }
      return (cfg.runHandler ?? defaultRun)(file, args, cwd);
    },
    async which() {
      return cfg.whichResult ?? null;
    },
    async fetchText(url) {
      if (url.includes("releases/latest")) {
        return JSON.stringify({
          tag_name: `v${latestVersion}`,
          prerelease: false,
          assets: [
            { name: assetName, browser_download_url: `https://example/${assetName}` },
            { name: "checksums.txt", browser_download_url: "https://example/checksums.txt" },
          ],
        });
      }
      if (url.includes("checksums.txt")) {
        const sha = cfg.corruptDownload ? "0".repeat(64) : correctSha;
        return `${sha}  ${assetName}\n`;
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    async download(_url, destPath) {
      await fsp.writeFile(destPath, assetBytes);
    },
    async extract(_archivePath, _kind, destDir) {
      // Simulate extracting a single binary file.
      const out = path.join(destDir, binaryName);
      await fsp.writeFile(out, assetBytes);
    },
    async addToUserPath(dir) {
      rec.addedPaths.push(dir);
      return true;
    },
    async removeFromUserPath(dir) {
      rec.removedPaths.push(dir);
      return true;
    },
  };

  return { core: new RtkManagerCore(adapters), rec, storageDir, homeDir, adapters };
}

test("resolveBinary prefers a validated PATH binary", async () => {
  const { core } = await makeManager({ whichResult: "/usr/bin/rtk" });
  const { info, conflictPath } = await core.resolveBinary();
  assert.equal(conflictPath, null);
  assert.equal(info?.source, "path");
  assert.equal(info?.path, "/usr/bin/rtk");
  assert.equal(info?.pathReady, true);
});

test("a same-named wrong-distribution binary on PATH is reported as a conflict", async () => {
  const { core } = await makeManager({
    whichResult: "/usr/bin/rtk",
    runHandler: (_file, args) => {
      // Wrong distribution: --version works but gain output is invalid.
      if (args[0] === "--version") return { stdout: "rtk 9.9.9", stderr: "", exitCode: 0 };
      return { stdout: "{}", stderr: "", exitCode: 0 };
    },
  });
  const { info, conflictPath } = await core.resolveBinary();
  assert.equal(conflictPath, "/usr/bin/rtk");
  assert.equal(info, null); // no managed binary installed yet
});

test("ensureBinary installs a managed binary when nothing is on PATH", async () => {
  const { core, storageDir } = await makeManager();
  const info = await core.ensureBinary();
  assert.equal(info.source, "managed");
  assert.ok(fs.existsSync(info.path));
  assert.ok(info.path.startsWith(path.join(storageDir, "bin")));
  assert.ok(fs.existsSync(path.join(storageDir, "rtk-manifest.json")));
});

test("checksum mismatch aborts install and leaves no managed binary", async () => {
  const { core, storageDir } = await makeManager({ corruptDownload: true });
  await assert.rejects(() => core.ensureBinary(), /Checksum mismatch/);
  assert.equal(fs.existsSync(path.join(storageDir, "bin", "rtk")), false);
  assert.equal(fs.existsSync(path.join(storageDir, "rtk-manifest.json")), false);
});

test("a downloaded binary that fails validation aborts install", async () => {
  const { core, storageDir } = await makeManager({ invalidExtractedBinary: true });
  await assert.rejects(() => core.ensureBinary(), /failed validation/);
  assert.equal(fs.existsSync(path.join(storageDir, "rtk-manifest.json")), false);
});

test("setup runs `rtk init` in the workspace cwd for workspace scope", async () => {
  const { core, rec } = await makeManager();
  await core.ensureBinary();
  await core.setup("workspace", "/my/workspace");
  const initRun = rec.runs.find((r) => r.args[0] === "init");
  assert.ok(initRun);
  assert.equal(initRun?.cwd, "/my/workspace");
});

test("a workspace operation without a workspace dir is rejected", async () => {
  const { core } = await makeManager();
  await core.ensureBinary();
  await assert.rejects(() => core.setup("workspace"), /workspace folder is required/);
});

test("setup pins the global hook to the managed binary's absolute path without double-escaping", async () => {
  let hookFile = "";
  const { core, homeDir, storageDir } = await makeManager({
    // When `rtk init` runs, emulate the real CLI writing a bare-`rtk` hook file.
    runHandler: (_file, args) => {
      if (args[0] === "--version") {
        return { stdout: "rtk 1.2.3", stderr: "", exitCode: 0 };
      }
      if (args[0] === "gain") {
        return { stdout: VALID_GAIN, stderr: "", exitCode: 0 };
      }
      if (args[0] === "init") {
        hookFile = path.join(homeDir, ".copilot", "hooks", "rtk-rewrite.json");
        fs.mkdirSync(path.dirname(hookFile), { recursive: true });
        fs.writeFileSync(
          hookFile,
          JSON.stringify({
            version: 1,
            hooks: {
              PreToolUse: [{ type: "command", command: "rtk hook copilot" }],
              preToolUse: [{ type: "command", bash: "rtk hook copilot", powershell: "rtk hook copilot" }],
            },
          })
        );
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await core.ensureBinary();
  await core.setup("global");

  const raw = fs.readFileSync(hookFile, "utf8");
  // Must remain valid JSON after pinning.
  const parsed = JSON.parse(raw) as {
    hooks: { PreToolUse: { command: string }[]; preToolUse: { bash: string; powershell: string }[] };
  };
  // The manager defaults to the "linux" platform in tests, so the managed
  // binary name has no .exe suffix regardless of the host running the test.
  const managedBinary = path.join(storageDir, "bin", rtkBinaryName("linux"));
  // The pinned command points at the managed binary by absolute path...
  assert.equal(parsed.hooks.PreToolUse[0].command, `${managedBinary} hook copilot`);
  assert.equal(parsed.hooks.preToolUse[0].bash, `${managedBinary} hook copilot`);
  assert.equal(parsed.hooks.preToolUse[0].powershell, `${managedBinary} hook copilot`);
  // ...and no command starts with a bare `rtk` token anymore.
  assert.doesNotMatch(parsed.hooks.PreToolUse[0].command, /^rtk\b/);
  // Guard against the double-escaping regression: a quadruple backslash in the
  // raw file text means a Windows path was escaped twice and is now corrupt.
  assert.ok(!raw.includes("\\\\\\\\"), "hook file must not contain double-escaped backslashes");
});

test("uninstall uses the official fixed `rtk init --uninstall` command", async () => {
  const { core, rec } = await makeManager();
  await core.ensureBinary();
  await core.uninstall("global");
  const un = rec.runs.find((r) => r.args.includes("--uninstall"));
  assert.ok(un);
  assert.deepEqual(un?.args, ["init", "--uninstall", "--global", "--copilot"]);
  assert.equal(un?.cwd, undefined);
});

test("getGain parses the JSON gain summary", async () => {
  const { core } = await makeManager();
  await core.ensureBinary();
  const gain = await core.getGain("global");
  assert.equal(gain.totalCommands, 0);
  assert.equal(gain.savingsPercent, 0);
});

test("ensureManagedOnPath creates a Renn-owned ~/.local/bin symlink on POSIX", { skip: !canSymlink }, async () => {
  const { core, homeDir } = await makeManager({ platform: "linux" });
  await core.ensureBinary();
  await core.ensureManagedOnPath();
  const link = path.join(homeDir, ".local", "bin", "rtk");
  assert.ok(fs.existsSync(link));
  const target = await fsp.readlink(link);
  assert.ok(target.includes(path.join("storage", "bin", "rtk")));
});

test("ensureManagedOnPath refuses to clobber a non-Renn ~/.local/bin/rtk", async () => {
  const { core, homeDir } = await makeManager({ platform: "linux" });
  await core.ensureBinary();
  const dir = path.join(homeDir, ".local", "bin");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "rtk"), "user-owned");
  await assert.rejects(() => core.ensureManagedOnPath(), /not managed by Renn/);
});

test("ensureManagedOnPath adds the managed dir to the user PATH on Windows", async () => {
  const { core, rec, storageDir } = await makeManager({ platform: "win32", arch: "x64" });
  await core.ensureBinary();
  const res = await core.ensureManagedOnPath();
  assert.equal(rec.addedPaths[0], path.join(storageDir, "bin"));
  assert.equal(res.restartRequired, true);
});

test("removeManaged deletes only Renn-owned artifacts", { skip: !canSymlink }, async () => {
  const { core, homeDir, storageDir } = await makeManager({ platform: "linux" });
  await core.ensureBinary();
  await core.ensureManagedOnPath();
  await core.removeManaged();
  assert.equal(fs.existsSync(path.join(homeDir, ".local", "bin", "rtk")), false);
  assert.equal(fs.existsSync(path.join(storageDir, "bin")), false);
  assert.equal(fs.existsSync(path.join(storageDir, "rtk-manifest.json")), false);
});

test("removeManaged leaves a user-owned symlink target untouched", { skip: !canSymlink }, async () => {
  const { core, homeDir } = await makeManager({ platform: "linux" });
  // Install but do not let Renn create the symlink; user makes their own.
  await core.ensureBinary();
  const dir = path.join(homeDir, ".local", "bin");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.symlink("/some/other/rtk", path.join(dir, "rtk"));
  await core.removeManaged();
  // Renn didn't create it, so the manifest's createdSymlink is false: untouched.
  assert.ok(fs.existsSync(path.join(dir, "rtk")));
  assert.equal(await fsp.readlink(path.join(dir, "rtk")), "/some/other/rtk");
});

test("getStatus reports unsupported platforms clearly", async () => {
  const { core } = await makeManager({ platform: "win32", arch: "arm64" });
  const status = await core.getStatus("/ws");
  assert.equal(status.platformSupported, false);
  assert.equal(status.binary, null);
  assert.match(status.warning ?? "", /No official RTK release/);
});

test("getStatus flags an available update", async () => {
  // An older binary on PATH against a newer latest release.
  const { core } = await makeManager({
    whichResult: "/usr/bin/rtk",
    latestVersion: "2.0.0",
    runHandler: (_f, args) => {
      if (args[0] === "--version") return { stdout: "rtk 1.0.0", stderr: "", exitCode: 0 };
      return { stdout: VALID_GAIN, stderr: "", exitCode: 0 };
    },
  });
  const status = await core.getStatus("/ws");
  assert.equal(status.binary?.version, "1.0.0");
  assert.equal(status.updateAvailable, true);
});

test("concurrent mutating operations are serialized", async () => {
  const { core, rec } = await makeManager();
  await core.ensureBinary();
  await Promise.all([core.setup("global"), core.setup("global"), core.setup("global")]);
  const inits = rec.runs.filter((r) => r.args[0] === "init");
  assert.equal(inits.length, 3);
});
