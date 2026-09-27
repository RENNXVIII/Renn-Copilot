import * as vscode from "vscode";
import { inspectSkill, removeSkill } from "./skills-core";
import { installSkill, listWondelSkills, resolveSkill } from "./skills-source";

export async function handleSkillsMessage(message: unknown, webview: vscode.Webview): Promise<void> {
  if (!message || typeof message !== "object") return;
  const request = message as Record<string, unknown>;
  if (request.command !== "skills" || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 100) return;
  if (request.action !== "list" && request.action !== "status" && request.action !== "install" && request.action !== "remove") return;
  const reply = (extra: Record<string, unknown>) => webview.postMessage({ command: "skillsResponse", requestId: request.requestId, ...extra });

  try {
    if (request.action === "list") return void await reply({ names: await listWondelSkills() });
    if (typeof request.id !== "string") throw new Error("Invalid skill.");
    const source = resolveSkill(request.id);
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error("Open a workspace folder before managing skills.");
    if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before managing skills.");
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Select the folder for this skill" });
    if (!folder) return void await reply({ cancelled: true });
    const workspace = folder.uri.fsPath;
    if (request.action === "install" || request.action === "remove") {
      const verb = request.action === "install" ? "Install" : "Remove";
      const choice = await vscode.window.showWarningMessage(
        `${verb} ${source.name} in ${folder.name}?`,
        { modal: true, detail: request.action === "install"
          ? `Renn will download skill files from ${source.repo} into .github/skills/${source.name}. Review third-party skills before using them. Scripts will not run during installation.`
          : "Renn will remove only the unmodified skill files it installed. User-owned files remain untouched." },
        verb
      );
      if (choice !== verb) return void await reply({ cancelled: true });
      if (request.action === "install") await installSkill(workspace, request.id);
      else await removeSkill(workspace, source.name);
    }
    await reply({ status: await inspectSkill(workspace, source.name) });
  } catch (err) {
    await reply({ error: err instanceof Error ? err.message : String(err) });
  }
}