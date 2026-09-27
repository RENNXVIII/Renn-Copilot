import * as fs from "node:fs/promises";
import * as path from "node:path";

// Inspired by Ponytail (MIT): https://github.com/DietrichGebert/ponytail
// Separate file so existing .github/copilot-instructions.md stays untouched.

// Exact text written by 0.9.0/0.9.1 (no mode support). Kept so those files
// are still recognized as Renn-owned (reported as "full") and can be switched.
export const LEGACY_PONYTAIL_INSTRUCTIONS = `---
applyTo: "**"
---
# Ponytail · minimal, correct changes

Before coding, understand the request and trace the code it affects. Choose the first sufficient option: skip unnecessary work, reuse existing code, use the standard library, use native platform features, reuse an installed dependency, or write the smallest implementation that works.

Prefer removing unnecessary code to adding abstractions. Fix root causes rather than patching each symptom. Keep the change focused; do not add speculative features or dependencies.

Never trade away input validation, security, accessibility, data-loss prevention, or necessary error handling. Verify non-trivial changes with an appropriate runnable check. User requirements and workspace rules take precedence.
`;

export const PONYTAIL_MODES = ["lite", "full", "ultra"] as const;
export type PonytailMode = (typeof PONYTAIL_MODES)[number];

// Intensity wording follows upstream's lite/full/ultra table.
const MODE_RULES: Record<PonytailMode, string> = {
  lite: "Mode: lite. Build what is asked. When a clearly simpler alternative exists (standard library, native feature, existing helper), name it in one line and let the user choose.",
  full: "Mode: full. Apply the steps above strictly: prefer the standard library and native features, keep the smallest diff, and keep explanations short. Briefly note anything skipped and when it would be worth adding.",
  ultra: "Mode: ultra. Prefer deleting code to adding it. Ship the smallest solution that works and question any part of the requirement that looks speculative, in the same response. Explicit user requirements still win.",
};

export function ponytailInstructions(mode: PonytailMode): string {
  return `---
applyTo: "**"
---
# Ponytail · minimal, correct changes

Before coding, understand the request and trace the code it affects. Choose the first sufficient option: skip unnecessary work, reuse existing code, use the standard library, use native platform features, reuse an installed dependency, or write the smallest implementation that works.

Prefer removing unnecessary code to adding abstractions. Fix root causes rather than patching each symptom. Keep the change focused; do not add speculative features or dependencies.

${MODE_RULES[mode]}

Never trade away input validation, security, accessibility, data-loss prevention, or necessary error handling. Verify non-trivial changes with an appropriate runnable check. User requirements and workspace rules take precedence.
`;
}

export function isPonytailMode(value: unknown): value is PonytailMode {
  return PONYTAIL_MODES.includes(value as PonytailMode);
}

export type PonytailStatus = "enabled" | "disabled" | "conflict";
export interface PonytailState { status: PonytailStatus; mode?: PonytailMode }

// Only content Renn itself wrote counts as managed; anything else is a conflict.
function modeOf(content: string): PonytailMode | null {
  if (content === LEGACY_PONYTAIL_INSTRUCTIONS) return "full";
  return PONYTAIL_MODES.find((mode) => ponytailInstructions(mode) === content) ?? null;
}

async function safeTarget(workspaceDir: string): Promise<string> {
  const github = path.join(workspaceDir, ".github");
  const instructions = path.join(github, "instructions");
  for (const dir of [github, instructions]) {
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing non-directory or linked path: ${dir}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return path.join(instructions, "renn-ponytail.instructions.md");
}

export async function ponytailStatus(workspaceDir: string): Promise<PonytailState> {
  const target = await safeTarget(workspaceDir);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: "conflict" };
    const mode = modeOf(await fs.readFile(target, "utf8"));
    return mode ? { status: "enabled", mode } : { status: "conflict" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "disabled" };
    throw err;
  }
}

/** Enables Ponytail, or switches the mode of a Renn-managed file. */
export async function enablePonytail(workspaceDir: string, mode: PonytailMode): Promise<void> {
  if (!isPonytailMode(mode)) throw new Error("Unknown Ponytail mode.");
  const current = await ponytailStatus(workspaceDir);
  if (current.status === "conflict") throw new Error("Ponytail instruction file has been modified; refusing to overwrite it.");
  const target = await safeTarget(workspaceDir);
  const content = ponytailInstructions(mode);
  if (current.status === "enabled") {
    if (await fs.readFile(target, "utf8") === content) return;
    // Overwrite only the file we just verified as Renn-owned.
    await fs.writeFile(target, content);
    return;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  // wx prevents overwriting a file created between the status check and write.
  await fs.writeFile(target, content, { flag: "wx" });
}

export async function disablePonytail(workspaceDir: string): Promise<void> {
  const current = await ponytailStatus(workspaceDir);
  if (current.status === "disabled") return;
  if (current.status === "conflict") throw new Error("Ponytail instruction file has been modified; refusing to remove it.");
  await fs.unlink(await safeTarget(workspaceDir));
}