import * as vscode from "vscode";
import { disablePonytail, enablePonytail, isPonytailMode, ponytailStatus, type PonytailState } from "./ponytail-core";

/** Only fixed intents cross from the untrusted webview. Paths come from VS Code. */
export async function handlePonytailMessage(message: unknown, webview: vscode.Webview): Promise<void> {
  if (!message || typeof message !== "object") return;
  const request = message as Record<string, unknown>;
  if (request.command !== "ponytail" || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 100) return;
  if (request.action !== "status" && request.action !== "enable" && request.action !== "disable") return;
  if (request.action === "enable" && !isPonytailMode(request.mode)) return;

  const reply = async (state?: PonytailState, error?: string, cancelled?: boolean) => {
    await webview.postMessage({ command: "ponytailResponse", requestId: request.requestId, status: state?.status, mode: state?.mode, error, cancelled });
  };
  try {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error("Open a workspace folder to configure Ponytail.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before configuring Ponytail.");
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the folder for Ponytail instructions" });
    if (!folder) return reply(undefined, undefined, true);
    const workspaceDir = folder.uri.fsPath;

    if (request.action !== "status") {
      const mode = request.action === "enable" && isPonytailMode(request.mode) ? request.mode : undefined;
      const current = await ponytailStatus(workspaceDir);
      // Switching mode on an already-enabled, Renn-owned file needs no modal:
      // it only rewrites the file the user already approved.
      const needsConfirm = !(mode && current.status === "enabled");
      if (needsConfirm) {
        const verb = mode ? "Enable" : "Disable";
        const choice = await vscode.window.showWarningMessage(
          `${verb} Ponytail${mode ? ` (${mode})` : ""} instructions in ${folder.name}?`,
          { modal: true, detail: "Only .github/instructions/renn-ponytail.instructions.md in the selected folder is managed. Existing Copilot instructions will not be changed." },
          verb
        );
        if (choice !== verb) return reply(current, undefined, true);
      }
      if (mode) await enablePonytail(workspaceDir, mode);
      else await disablePonytail(workspaceDir);
    }
    await reply(await ponytailStatus(workspaceDir));
  } catch (err) {
    await reply(undefined, err instanceof Error ? err.message : String(err));
  }
}