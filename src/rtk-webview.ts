// Bridge between the webview UI and RtkManagerCore, shared by both the
// editor-tab panel and the Activity Bar sidebar.
//
// Security model: the webview never supplies an executable path, URL, argument
// array, or working directory. It can only pick one of a fixed set of intents
// ("getStatus" | "setup" | "uninstall" | "refreshGain" | "removeManaged") and a
// scope ("workspace" | "global"). The extension host is the sole authority that
// turns those into real subprocess calls -- it resolves the workspace folder
// itself, blocks untrusted/absent workspaces, and confirms every mutating or
// PATH-touching action with the user before doing it.

import * as vscode from "vscode";
import { RtkManagerCore, RtkStatus } from "./rtk-manager";
import { RtkScope, RtkGainSummary } from "./rtk-core";

/** A request the webview may send. Anything else is rejected. */
export interface RtkRequest {
  command: "rtk";
  requestId: string;
  action: "getStatus" | "setup" | "uninstall" | "refreshGain" | "removeManaged";
  scope?: RtkScope;
}

/** The response the host posts back, correlated by requestId. */
export interface RtkResponse {
  command: "rtkResponse";
  requestId: string;
  ok: boolean;
  status?: RtkStatus;
  gain?: RtkGainSummary;
  error?: string;
  /** True when the user cancelled a confirmation dialog (not an error). */
  cancelled?: boolean;
}

function isRtkScope(value: unknown): value is RtkScope {
  return value === "workspace" || value === "global";
}

/** Narrows an arbitrary webview message to a valid RtkRequest, or null. */
export function parseRtkRequest(message: unknown): RtkRequest | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.command !== "rtk") return null;
  if (typeof m.requestId !== "string" || !m.requestId) return null;
  const action = m.action;
  if (
    action !== "getStatus" &&
    action !== "setup" &&
    action !== "uninstall" &&
    action !== "refreshGain" &&
    action !== "removeManaged"
  ) {
    return null;
  }
  const scope = m.scope === undefined ? undefined : isRtkScope(m.scope) ? m.scope : null;
  if (scope === null) return null;
  return { command: "rtk", requestId: m.requestId, action, scope };
}

/** Anything that can receive a posted response (WebviewPanel or WebviewView). */
export interface RtkResponseSink {
  postMessage(message: RtkResponse): Thenable<boolean>;
}

/**
 * Handles one validated RTK request end-to-end and posts the response back.
 * Errors are converted into `{ ok: false, error }` rather than thrown, so the
 * webview always gets a reply for every requestId it sends.
 */
export class RtkWebviewDispatcher {
  constructor(private readonly manager: RtkManagerCore) {}

  async handle(raw: unknown, sink: RtkResponseSink): Promise<void> {
    const req = parseRtkRequest(raw);
    if (!req) return; // Not an RTK message; other handlers deal with it.

    try {
      const response = await this.run(req);
      await sink.postMessage(response);
    } catch (err) {
      await sink.postMessage({
        command: "rtkResponse",
        requestId: req.requestId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async run(req: RtkRequest): Promise<RtkResponse> {
    const reply = (extra: Partial<RtkResponse>): RtkResponse => ({
      command: "rtkResponse",
      requestId: req.requestId,
      ok: true,
      ...extra,
    });

    switch (req.action) {
      case "getStatus": {
        const workspaceDir = this.optionalWorkspaceDir();
        const status = await this.manager.getStatus(workspaceDir);
        return reply({ status });
      }

      case "refreshGain": {
        const scope = req.scope ?? "global";
        const workspaceDir = scope === "workspace" ? await this.requireWorkspaceDir() : undefined;
        const gain = await this.manager.getGain(scope, workspaceDir);
        return reply({ gain });
      }

      case "setup": {
        const scope = req.scope ?? "global";
        const workspaceDir = scope === "workspace" ? await this.requireWorkspaceDir() : undefined;

        const confirmed = await this.confirmSetup(scope);
        if (!confirmed) return reply({ cancelled: true });

        // Ensure a usable binary exists and is reachable on PATH before wiring
        // Copilot's hook (which calls `rtk` by name).
        await this.manager.ensureBinary();
        await this.manager.ensureManagedOnPath().catch(() => undefined);
        await this.manager.setup(scope, workspaceDir);

        const status = await this.manager.getStatus(this.optionalWorkspaceDir());
        // The setup step pins the hook to an absolute binary path, so only the
        // final status can determine whether a restart is still necessary.
        if (status.restartRequired) {
          void vscode.window.showInformationMessage(
            "Renn Copilot: RTK is installed. Restart VS Code so GitHub Copilot can find the `rtk` command on PATH."
          );
        } else {
          void vscode.window.showInformationMessage(
            `Renn Copilot: RTK enabled for GitHub Copilot (${scope}).`
          );
        }
        return reply({ status });
      }

      case "uninstall": {
        const scope = req.scope ?? "global";
        const workspaceDir = scope === "workspace" ? await this.requireWorkspaceDir() : undefined;

        const confirmed = await this.confirm(
          `Remove RTK from GitHub Copilot (${scope})?`,
          "This runs the official `rtk init --uninstall` to remove the Copilot hook and instructions. The managed binary itself is kept.",
          "Remove"
        );
        if (!confirmed) return reply({ cancelled: true });

        await this.manager.uninstall(scope, workspaceDir);
        const status = await this.manager.getStatus(this.optionalWorkspaceDir());
        return reply({ status });
      }

      case "removeManaged": {
        const confirmed = await this.confirm(
          "Delete the managed RTK binary?",
          "This removes only the RTK binary Renn installed and, on Windows, the PATH entry Renn added. A user- or package-manager-installed `rtk` is never touched.",
          "Delete"
        );
        if (!confirmed) return reply({ cancelled: true });

        await this.manager.removeManaged();
        const status = await this.manager.getStatus(this.optionalWorkspaceDir());
        return reply({ status });
      }
    }
  }

  private async confirmSetup(scope: RtkScope): Promise<boolean> {
    const detail =
      scope === "global"
        ? "Renn will install a managed `rtk` binary, add it to your user PATH (Windows) or ~/.local/bin (macOS/Linux), and run the official `rtk init --global --copilot` to wire GitHub Copilot everywhere."
        : "Renn will install a managed `rtk` binary, make it available on PATH, and run the official `rtk init --copilot` in this workspace.";
    return this.confirm(`Enable RTK for GitHub Copilot (${scope})?`, detail, "Enable");
  }

  private async confirm(message: string, detail: string, confirmLabel: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      message,
      { modal: true, detail },
      confirmLabel
    );
    return choice === confirmLabel;
  }

  /** The first workspace folder path, or undefined when none is open. */
  private optionalWorkspaceDir(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return folders[0].uri.fsPath;
  }

  /**
   * Resolves the workspace folder for a workspace-scoped mutation, requiring a
   * trusted, single (or user-picked) folder. Throws a user-facing message when
   * that can't be satisfied.
   */
  private async requireWorkspaceDir(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error("Open a workspace folder before configuring RTK for the workspace.");
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error("This workspace is not trusted. Trust it before configuring RTK for the workspace.");
    }
    if (folders.length === 1) return folders[0].uri.fsPath;

    const picked = await vscode.window.showWorkspaceFolderPick({
      placeHolder: "Select the workspace folder to configure RTK for",
    });
    if (!picked) throw new Error("No workspace folder selected.");
    return picked.uri.fsPath;
  }
}
