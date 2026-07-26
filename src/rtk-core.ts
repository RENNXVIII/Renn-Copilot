// Pure, VS Code-free domain logic for the RTK (Rust Token Killer) integration.
//
// RTK (github.com/rtk-ai/rtk) is a short-lived CLI wrapper/output filter that
// GitHub Copilot invokes through official PreToolUse hooks -- it is NOT a
// daemon and NOT a network proxy. This module owns everything that can be
// reasoned about and unit-tested without touching the filesystem, network, or
// child processes:
//
//   - which release asset maps to a given OS/arch (fixed allowlist),
//   - the exact, fixed argument arrays for the official `rtk` operations,
//   - parsing `rtk --version` and `rtk gain ... --format json`,
//   - parsing a `checksums.txt` file,
//   - rejecting unsafe archive entries before extraction.
//
// Keeping this logic here (and free of `vscode`/`node:fs` side effects) is what
// lets src/test/rtk-core.test.ts run under `node --test` with no mocking.

export const RTK_GITHUB_REPO = "rtk-ai/rtk";

/** Where an RTK Copilot integration is applied. */
export type RtkScope = "workspace" | "global";

/**
 * The only operations the extension host is ever allowed to run against the
 * `rtk` binary. The webview picks an operation + scope; it can never supply raw
 * arguments, so every subprocess invocation is one of these fixed shapes.
 */
export type RtkOperation = "setup" | "uninstall" | "gain";

/** The five platform/arch combinations RTK ships an official release asset for. */
export interface RtkAsset {
  /** Exact release asset file name. */
  fileName: string;
  /** Whether the archive is a .zip (Windows) vs a .tar.gz (macOS/Linux). */
  kind: "zip" | "tar.gz";
}

/**
 * Maps a Node platform/arch pair to the matching `rtk-ai/rtk` release asset.
 * Returns null for any unsupported combination (notably Windows arm64, for
 * which RTK publishes no official build) so callers can surface a clear
 * "unsupported platform" state instead of guessing.
 */
export function rtkAssetFor(platform: NodeJS.Platform, arch: string): RtkAsset | null {
  if (platform === "win32") {
    if (arch === "x64") return { fileName: "rtk-x86_64-pc-windows-msvc.zip", kind: "zip" };
    return null;
  }
  if (platform === "darwin") {
    if (arch === "x64") return { fileName: "rtk-x86_64-apple-darwin.tar.gz", kind: "tar.gz" };
    if (arch === "arm64") return { fileName: "rtk-aarch64-apple-darwin.tar.gz", kind: "tar.gz" };
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return { fileName: "rtk-x86_64-unknown-linux-musl.tar.gz", kind: "tar.gz" };
    if (arch === "arm64") return { fileName: "rtk-aarch64-unknown-linux-gnu.tar.gz", kind: "tar.gz" };
    return null;
  }
  return null;
}

/** The binary file name RTK extracts to for a given platform. */
export function rtkBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "rtk.exe" : "rtk";
}

/**
 * Builds the exact, fixed argument array for an official RTK operation.
 *
 * These mirror RTK's documented Copilot commands:
 *   setup     workspace -> rtk init --copilot
 *             global    -> rtk init --global --copilot
 *   uninstall workspace -> rtk init --uninstall --copilot
 *             global    -> rtk init --uninstall --global --copilot
 *   gain      workspace -> rtk gain --project --all --format json
 *             global    -> rtk gain --all --format json
 *
 * The `--project` flag scopes `gain` analytics to the current working directory
 * (the selected workspace) so the workspace view doesn't leak global totals.
 */
export function rtkArgs(operation: RtkOperation, scope: RtkScope): string[] {
  switch (operation) {
    case "setup":
      return scope === "global" ? ["init", "--global", "--copilot"] : ["init", "--copilot"];
    case "uninstall":
      return scope === "global"
        ? ["init", "--uninstall", "--global", "--copilot"]
        : ["init", "--uninstall", "--copilot"];
    case "gain":
      return scope === "global"
        ? ["gain", "--all", "--format", "json"]
        : ["gain", "--project", "--all", "--format", "json"];
  }
}

/**
 * Extracts a semver-looking version from `rtk --version` output
 * (e.g. "rtk 0.43.0" -> "0.43.0"). Returns null when no version is present.
 */
export function parseRtkVersion(output: string): string | null {
  const match = String(output ?? "").match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** Returns true when `a` is a strictly older semver than `b`. */
export function isVersionOlder(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r;
  }
  return false;
}

/**
 * Parses a `checksums.txt` file into a map of fileName -> lowercase sha256 hex.
 *
 * Accepts the standard `sha256sum` layout, one entry per line:
 *   <64-hex-digest>  <filename>
 * The two-space separator is canonical, but a single space or `*` binary
 * marker (`<digest> *<filename>`) is tolerated. Malformed lines are skipped.
 */
export function parseChecksumFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const digest = match[1].toLowerCase();
    const fileName = match[2].trim();
    if (fileName) map.set(fileName, digest);
  }
  return map;
}

/**
 * Rejects archive entry paths that would escape the extraction directory.
 *
 * Blocks absolute POSIX paths, Windows drive-letter and UNC paths, and any
 * `..` traversal component. This is a defense-in-depth check applied to every
 * entry before extraction -- the extraction library alone is not treated as a
 * security boundary.
 */
export function isSafeArchiveEntry(entryName: string): boolean {
  if (typeof entryName !== "string" || entryName.length === 0) return false;
  const normalized = entryName.replace(/\\/g, "/");
  // Absolute POSIX path.
  if (normalized.startsWith("/")) return false;
  // Windows drive-letter (C:...) or UNC (\\host\share -> //host/share).
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  if (normalized.startsWith("//")) return false;
  // Any `..` traversal component.
  const parts = normalized.split("/");
  if (parts.some((p) => p === "..")) return false;
  return true;
}

/** A single day/week/month row from `rtk gain ... --format json`. */
export interface RtkGainPeriod {
  /** Period label: date (daily), week key (weekly), or month (monthly). */
  period: string;
  commands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
}

/** The normalized shape the dashboard renders. */
export interface RtkGainSummary {
  totalCommands: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number;
  savingsPercent: number;
  totalTimeMs: number;
  avgTimeMs: number;
  daily: RtkGainPeriod[];
  weekly: RtkGainPeriod[];
  monthly: RtkGainPeriod[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a required, finite, non-negative number from an untrusted record.
 * Throws so a malformed/partial gain payload fails loudly rather than silently
 * rendering NaN in the dashboard.
 */
function requireCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`rtk gain: field "${key}" is missing or invalid`);
  }
  return value;
}

/** Reads an optional non-negative number, defaulting to 0 when absent. */
function optionalCount(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`rtk gain: field "${key}" is invalid`);
  }
  return value;
}

/**
 * Parses one period row. RTK uses `date` for daily, `week`/`week_start` for
 * weekly, and `month` for monthly, so the period label is read from whichever
 * key is present.
 */
function parsePeriod(value: unknown): RtkGainPeriod {
  if (!isRecord(value)) throw new Error("rtk gain: period entry is not an object");
  const period =
    (typeof value.date === "string" && value.date) ||
    (typeof value.week === "string" && value.week) ||
    (typeof value.week_start === "string" && value.week_start) ||
    (typeof value.month === "string" && value.month) ||
    "";
  return {
    period,
    commands: optionalCount(value, "commands"),
    inputTokens: optionalCount(value, "input_tokens"),
    outputTokens: optionalCount(value, "output_tokens"),
    savedTokens: optionalCount(value, "saved_tokens"),
    savingsPercent: optionalCount(value, "savings_pct"),
  };
}

function parsePeriodArray(value: unknown): RtkGainPeriod[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("rtk gain: period list is not an array");
  return value.map(parsePeriod);
}

/**
 * Validates and normalizes the output of `rtk gain ... --format json`.
 *
 * The upstream schema is:
 *   { "summary": { total_commands, total_input, total_output, total_saved,
 *                  avg_savings_pct, total_time_ms, avg_time_ms },
 *     "daily": [...], "weekly": [...], "monthly": [...] }
 *
 * Extra/unknown fields are tolerated; missing or invalid *required* summary
 * fields throw. An empty tracking database still yields a valid summary with
 * all-zero totals.
 */
export function parseRtkGain(value: unknown): RtkGainSummary {
  if (!isRecord(value)) throw new Error("rtk gain: root is not an object");
  const summary = value.summary;
  if (!isRecord(summary)) throw new Error("rtk gain: missing summary object");

  const savingsRaw = summary.avg_savings_pct;
  if (typeof savingsRaw !== "number" || !Number.isFinite(savingsRaw)) {
    throw new Error('rtk gain: field "avg_savings_pct" is missing or invalid');
  }

  return {
    totalCommands: requireCount(summary, "total_commands"),
    inputTokens: requireCount(summary, "total_input"),
    outputTokens: requireCount(summary, "total_output"),
    savedTokens: requireCount(summary, "total_saved"),
    savingsPercent: savingsRaw,
    totalTimeMs: optionalCount(summary, "total_time_ms"),
    avgTimeMs: optionalCount(summary, "avg_time_ms"),
    daily: parsePeriodArray(value.daily),
    weekly: parsePeriodArray(value.weekly),
    monthly: parsePeriodArray(value.monthly),
  };
}
