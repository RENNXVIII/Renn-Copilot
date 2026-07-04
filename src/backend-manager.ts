import * as vscode from "vscode";
import * as path from "node:path";
import * as http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";

const MAX_LOG_LINES = 2000;

let backendProcess: ChildProcess | null = null;
let lastStartError: string | null = null;
const logLines: string[] = [];

function pushLog(line: string) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  logLines.push(stamped);
  if (logLines.length > MAX_LOG_LINES) logLines.shift();
}

export function isRunning(): boolean {
  return backendProcess !== null && backendProcess.exitCode === null && backendProcess.signalCode === null;
}

function backendEntryPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "backend", "src", "index.js");
}

function backendCwd(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, "backend");
}

function resolvePort(backendUrl: string): string {
  try {
    const port = new URL(backendUrl).port;
    return port || "4317";
  } catch {
    return "4317";
  }
}

/**
 * Spawns the backend (a plain Node/ESM script, extension/backend/src/index.js)
 * using the same Electron binary that hosts the Extension Host itself
 * (process.execPath), with ELECTRON_RUN_AS_NODE=1 so it behaves like a
 * regular `node` invocation. This is the standard trick for VS Code
 * extensions that need to run a bundled Node script without depending on a
 * separately-installed system Node -- the end user only needs VS Code.
 */
export function startBackend(context: vscode.ExtensionContext): void {
  if (isRunning()) return;

  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
  const autoStartServer = config.get<boolean>("autoStartServer", true);
  const port = resolvePort(backendUrl);
  const entry = backendEntryPath(context);
  const cwd = backendCwd(context);

  lastStartError = null;
  pushLog(`Starting backend: ${entry} (cwd=${cwd}, port=${port})`);

  try {
    backendProcess = spawn(process.execPath, [entry], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PORT: port,
        RENN_AUTO_START_SERVER: autoStartServer ? "1" : "0",
      },
    });
  } catch (err: any) {
    lastStartError = `Failed to spawn backend: ${err.message}`;
    pushLog(lastStartError);
    backendProcess = null;
    return;
  }

  backendProcess.stdout?.on("data", (chunk) => pushLog(chunk.toString().trimEnd()));
  backendProcess.stderr?.on("data", (chunk) => pushLog(`[stderr] ${chunk.toString().trimEnd()}`));
  backendProcess.on("error", (err) => {
    lastStartError = `Backend process error: ${err.message}`;
    pushLog(lastStartError);
  });
  backendProcess.on("exit", (code, signal) => {
    pushLog(`Backend exited (code=${code}, signal=${signal})`);
    if (code !== null && code !== 0) {
      lastStartError = `Backend exited with code ${code}`;
    }
    backendProcess = null;
  });
}

function postNoBody(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", () => resolve());
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

/**
 * Two-step teardown: ask the backend to gracefully stop itself first (so its
 * own cliproxy-manager.stopServer() can cleanly terminate the CLIProxyAPI
 * grandchild process -- important on Windows, where killing just the Node
 * backend process would otherwise orphan that Go binary), then fall back to
 * a hard kill if the graceful request doesn't finish quickly.
 */
export async function stopBackend(backendUrl: string, gracefulTimeoutMs = 1500): Promise<void> {
  if (!isRunning()) return;
  const proc = backendProcess!;

  try {
    await postNoBody(`${backendUrl}/api/server/stop`, gracefulTimeoutMs);
    pushLog("Requested graceful CLIProxyAPI stop via /api/server/stop.");
  } catch {
    // Backend may already be down, or too slow -- fall through to hard kill.
  }

  await new Promise<void>((resolve) => {
    if (!isRunning()) {
      resolve();
      return;
    }
    const onExit = () => resolve();
    proc.once("exit", onExit);
    setTimeout(() => {
      proc.removeListener("exit", onExit);
      resolve();
    }, 500);
  });

  if (isRunning()) {
    pushLog("Backend still running after graceful stop attempt -- killing.");
    if (process.platform === "win32" && proc.pid) {
      spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"]);
    } else {
      proc.kill();
    }
  }
}
