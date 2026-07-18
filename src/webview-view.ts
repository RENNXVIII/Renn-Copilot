import * as vscode from "vscode";
import { getWebviewHtml } from "./webview-html";
import { openDashboardPanel } from "./webview-panel";

export const SIDEBAR_VIEW_ID = "rennCopilot.sidebarView";

/**
 * Persistent Activity Bar sidebar view -- same HTML shell as the editor-tab
 * panel, but the bundle renders a compact Sidebar component instead of the
 * full tabbed App (see webview-ui/src/main.tsx, gated on window.__RENN_VIEW_MODE__).
 */
export class RennSidebarViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };

    const config = vscode.workspace.getConfiguration("rennCopilot");
    const backendUrl = config.get<string>("backendUrl", "http://127.0.0.1:4317");
    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.context.extensionUri, backendUrl, "sidebar");

    webviewView.webview.onDidReceiveMessage((message: any) => {
      switch (message?.command) {
        case "openDashboardPanel":
          openDashboardPanel(this.context, message.page);
          break;
        case "syncModels":
          void vscode.commands.executeCommand("rennCopilot.syncModelsInternal");
          break;
        case "copyApiKey":
          void vscode.commands.executeCommand("rennCopilot.copyApiKey");
          break;
        case "openExternal":
          if (typeof message.url === "string") {
            void vscode.env.openExternal(vscode.Uri.parse(message.url));
          }
          break;
      }
    });
  }
}
