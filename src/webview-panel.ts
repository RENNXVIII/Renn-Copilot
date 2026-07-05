import * as vscode from "vscode";
import { getWebviewHtml } from "./webview-html";

let currentPanel: vscode.WebviewPanel | undefined;

/**
 * Singleton WebviewPanel (editor tab) -- reveals the existing one instead of
 * opening a second tab. `initialPage` (e.g. "models") is used by the sidebar's
 * quick links to land directly on a specific tab instead of always Overview.
 */
export function openDashboardPanel(context: vscode.ExtensionContext, initialPage?: string) {
  const config = vscode.workspace.getConfiguration("rennCopilot");
  const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    if (initialPage) {
      void currentPanel.webview.postMessage({ command: "navigate", page: initialPage });
    }
    return;
  }

  currentPanel = vscode.window.createWebviewPanel("rennCopilotDashboard", "Renn Copilot", vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    retainContextWhenHidden: true,
  });

  currentPanel.webview.html = getWebviewHtml(currentPanel.webview, context.extensionUri, backendUrl, "panel", initialPage);

  currentPanel.webview.onDidReceiveMessage((message: any) => {
    // A plain window.open() inside a webview doesn't reliably reach the
    // user's real browser (Electron sandboxing) -- OAuth login buttons
    // route through here instead so vscode.env.openExternal can do it properly.
    if (message?.command === "openExternal" && typeof message.url === "string") {
      void vscode.env.openExternal(vscode.Uri.parse(message.url));
    }
  });

  currentPanel.onDidDispose(
    () => {
      currentPanel = undefined;
    },
    null,
    context.subscriptions
  );
}
