import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rtkAssetFor,
  rtkBinaryName,
  rtkArgs,
  parseRtkVersion,
  isVersionOlder,
  parseChecksumFile,
  isSafeArchiveEntry,
  parseRtkGain,
} from "../rtk-core";

test("rtkAssetFor maps every supported platform/arch", () => {
  assert.deepEqual(rtkAssetFor("win32", "x64"), {
    fileName: "rtk-x86_64-pc-windows-msvc.zip",
    kind: "zip",
  });
  assert.deepEqual(rtkAssetFor("darwin", "x64"), {
    fileName: "rtk-x86_64-apple-darwin.tar.gz",
    kind: "tar.gz",
  });
  assert.deepEqual(rtkAssetFor("darwin", "arm64"), {
    fileName: "rtk-aarch64-apple-darwin.tar.gz",
    kind: "tar.gz",
  });
  assert.deepEqual(rtkAssetFor("linux", "x64"), {
    fileName: "rtk-x86_64-unknown-linux-musl.tar.gz",
    kind: "tar.gz",
  });
  assert.deepEqual(rtkAssetFor("linux", "arm64"), {
    fileName: "rtk-aarch64-unknown-linux-gnu.tar.gz",
    kind: "tar.gz",
  });
});

test("rtkAssetFor rejects unsupported platform/arch (incl. Windows arm64)", () => {
  assert.equal(rtkAssetFor("win32", "arm64"), null);
  assert.equal(rtkAssetFor("linux", "ia32"), null);
  assert.equal(rtkAssetFor("darwin", "ppc64"), null);
  assert.equal(rtkAssetFor("freebsd" as NodeJS.Platform, "x64"), null);
});

test("rtkBinaryName is platform-specific", () => {
  assert.equal(rtkBinaryName("win32"), "rtk.exe");
  assert.equal(rtkBinaryName("linux"), "rtk");
  assert.equal(rtkBinaryName("darwin"), "rtk");
});

test("rtkArgs builds the exact official argument arrays", () => {
  assert.deepEqual(rtkArgs("setup", "workspace"), ["init", "--copilot"]);
  assert.deepEqual(rtkArgs("setup", "global"), ["init", "--global", "--copilot"]);
  assert.deepEqual(rtkArgs("uninstall", "workspace"), ["init", "--uninstall", "--copilot"]);
  assert.deepEqual(rtkArgs("uninstall", "global"), [
    "init",
    "--uninstall",
    "--global",
    "--copilot",
  ]);
  assert.deepEqual(rtkArgs("gain", "workspace"), [
    "gain",
    "--project",
    "--all",
    "--format",
    "json",
  ]);
  assert.deepEqual(rtkArgs("gain", "global"), ["gain", "--all", "--format", "json"]);
});

test("parseRtkVersion extracts semver, else null", () => {
  assert.equal(parseRtkVersion("rtk 0.43.0"), "0.43.0");
  assert.equal(parseRtkVersion("rtk version 1.2.3 (abc)"), "1.2.3");
  assert.equal(parseRtkVersion("no version here"), null);
  assert.equal(parseRtkVersion(""), null);
});

test("isVersionOlder compares semver, tolerating missing values", () => {
  assert.equal(isVersionOlder("0.42.0", "0.43.0"), true);
  assert.equal(isVersionOlder("0.43.0", "0.43.0"), false);
  assert.equal(isVersionOlder("1.0.0", "0.43.0"), false);
  assert.equal(isVersionOlder(null, "0.43.0"), false);
  assert.equal(isVersionOlder("0.43.0", undefined), false);
});

test("parseChecksumFile parses standard sha256sum lines", () => {
  const digest = "a".repeat(64);
  const other = "b".repeat(64);
  const text = `${digest}  rtk-x86_64-pc-windows-msvc.zip\n${other} *rtk-x86_64-apple-darwin.tar.gz\n\ngarbage line\n`;
  const map = parseChecksumFile(text);
  assert.equal(map.get("rtk-x86_64-pc-windows-msvc.zip"), digest);
  assert.equal(map.get("rtk-x86_64-apple-darwin.tar.gz"), other);
  assert.equal(map.size, 2);
});

test("parseChecksumFile ignores malformed digests", () => {
  const map = parseChecksumFile("xyz  file\n123  short\n");
  assert.equal(map.size, 0);
});

test("isSafeArchiveEntry blocks traversal, absolute, and UNC/drive paths", () => {
  assert.equal(isSafeArchiveEntry("rtk"), true);
  assert.equal(isSafeArchiveEntry("dir/rtk"), true);
  assert.equal(isSafeArchiveEntry("../rtk"), false);
  assert.equal(isSafeArchiveEntry("dir/../../rtk"), false);
  assert.equal(isSafeArchiveEntry("/etc/passwd"), false);
  assert.equal(isSafeArchiveEntry("C:\\Windows\\rtk.exe"), false);
  assert.equal(isSafeArchiveEntry("\\\\host\\share\\rtk"), false);
  assert.equal(isSafeArchiveEntry(""), false);
});

test("parseRtkGain normalizes the upstream schema", () => {
  const raw = {
    summary: {
      total_commands: 196,
      total_input: 1276098,
      total_output: 59244,
      total_saved: 1220217,
      avg_savings_pct: 95.62,
      total_time_ms: 8450,
      avg_time_ms: 201,
    },
    daily: [
      {
        date: "2026-01-28",
        commands: 89,
        input_tokens: 380894,
        output_tokens: 26744,
        saved_tokens: 355779,
        savings_pct: 93.41,
      },
    ],
    weekly: [],
    monthly: [],
  };
  const summary = parseRtkGain(raw);
  assert.equal(summary.totalCommands, 196);
  assert.equal(summary.inputTokens, 1276098);
  assert.equal(summary.savedTokens, 1220217);
  assert.equal(summary.savingsPercent, 95.62);
  assert.equal(summary.avgTimeMs, 201);
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.daily[0].period, "2026-01-28");
  assert.equal(summary.daily[0].savedTokens, 355779);
});

test("parseRtkGain accepts an empty tracking database (all zeros)", () => {
  const summary = parseRtkGain({
    summary: {
      total_commands: 0,
      total_input: 0,
      total_output: 0,
      total_saved: 0,
      avg_savings_pct: 0,
    },
  });
  assert.equal(summary.totalCommands, 0);
  assert.equal(summary.daily.length, 0);
  assert.equal(summary.weekly.length, 0);
});

test("parseRtkGain tolerates unknown extra fields", () => {
  const summary = parseRtkGain({
    summary: {
      total_commands: 1,
      total_input: 2,
      total_output: 3,
      total_saved: 1,
      avg_savings_pct: 50,
      extra_upstream_field: "ignored",
    },
    future_top_level: [1, 2, 3],
  });
  assert.equal(summary.totalCommands, 1);
});

test("parseRtkGain rejects missing/invalid required fields", () => {
  assert.throws(() => parseRtkGain(null));
  assert.throws(() => parseRtkGain({}));
  assert.throws(() => parseRtkGain({ summary: {} }));
  assert.throws(() =>
    parseRtkGain({
      summary: {
        total_commands: -1,
        total_input: 0,
        total_output: 0,
        total_saved: 0,
        avg_savings_pct: 0,
      },
    })
  );
  assert.throws(() =>
    parseRtkGain({
      summary: {
        total_commands: 1,
        total_input: 2,
        total_output: 3,
        total_saved: 1,
        avg_savings_pct: Number.NaN,
      },
    })
  );
});
