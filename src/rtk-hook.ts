// Compatibility bridge between VS Code Copilot Chat hooks and upstream RTK.
//
// VS Code emits the terminal tool under a name that has drifted across builds
// (`run_in_terminal`, `runInTerminal`, ...), while RTK 0.43 only recognizes
// `runTerminalCommand`/`bash`. This process translates any of those terminal
// tool names, delegates all rewrite decisions to RTK, then pins RTK's rewritten
// command to the exact binary selected by Renn.

import { spawn } from "node:child_process";

const MAX_HOOK_OUTPUT_BYTES = 1_000_000;

/** The tool name upstream RTK recognizes as "run a terminal command". */
const RTK_TERMINAL_TOOL = "runTerminalCommand";

type JsonObject = Record<string, unknown>;

/**
 * True for any VS Code Copilot terminal-tool name. VS Code has shipped this
 * tool as `run_in_terminal` and (in newer agent builds) `runInTerminal`; both
 * separator styles are matched here so RTK always sees a name it understands.
 */
function isTerminalToolName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.replace(/[_-]/g, "").toLowerCase();
  return normalized === "runinterminal" || normalized === "runterminalcommand";
}

export function normalizeCopilotHookInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const obj = input as JsonObject;
  if (!isTerminalToolName(obj.tool_name)) return input;
  if (obj.tool_name === RTK_TERMINAL_TOOL) return input;
  return { ...obj, tool_name: RTK_TERMINAL_TOOL };
}

/**
 * Renders `value` as a leading command token that a shell will execute as a
 * program path. On Windows the integrated terminal is PowerShell, where a
 * double-quoted path at the start of a line is parsed as a *string literal*,
 * not a command -- it must be invoked with the call operator (`& "..."`).
 * POSIX shells execute a single-quoted path directly, so no operator is added.
 */
function quoteCommandToken(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `& "${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function pinRtkHookOutput(
  output: string,
  binaryPath: string,
  platform: NodeJS.Platform
): string {
  if (!output.trim()) return output;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return output;
  const root = parsed as JsonObject;
  const specific = root.hookSpecificOutput;
  if (!specific || typeof specific !== "object" || Array.isArray(specific)) return output;
  const updatedInput = (specific as JsonObject).updatedInput;
  if (!updatedInput || typeof updatedInput !== "object" || Array.isArray(updatedInput)) return output;
  const command = (updatedInput as JsonObject).command;
  if (typeof command !== "string") return output;
  const pinned = command.replace(
    /^(\s*)rtk(\.exe)?(\s|$)/i,
    `$1${quoteCommandToken(binaryPath, platform)}$3`
  );
  if (pinned === command) return output;
  (updatedInput as JsonObject).command = pinned;
  return JSON.stringify(parsed);
}

function runRtkHook(binaryPath: string, input: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["hook", "copilot"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
        child.kill();
        reject(new Error("RTK hook output exceeded the safety limit."));
        return;
      }
      if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.stdin.end(input);
  });
}

async function main(): Promise<void> {
  const binaryPath = process.argv[2];
  if (!binaryPath) throw new Error("Missing RTK binary path.");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const rawInput = Buffer.concat(chunks).toString("utf8");
  let forwarded = rawInput;
  try {
    forwarded = JSON.stringify(normalizeCopilotHookInput(JSON.parse(rawInput)));
  } catch {
    // Preserve upstream behavior for an unexpected/non-JSON hook payload.
  }
  const result = await runRtkHook(binaryPath, forwarded);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) {
    process.stdout.write(pinRtkHookOutput(result.stdout, binaryPath, process.platform));
  }
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}