import * as vscode from "vscode";

/**
 * Shared HTML shell used by both the WebviewPanel (editor tab) and the
 * WebviewViewProvider (Activity Bar sidebar), so there's exactly one
 * template to maintain. Loads the Vite-built bundle from media/webview/ and
 * injects the configured backend URL as a global so the webview's fetch
 * calls (webview-ui/src/api/client.ts) hit the right place without needing
 * a rebuild when the user changes rennCopilot.backendUrl.
 */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  backendUrl: string,
  mode: "panel" | "sidebar",
  initialPage?: string
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", "bundle.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview", "bundle.css"));
  const nonce = getNonce();

  // connect-src must explicitly allow the backend origin -- webviews default
  // to blocking all outbound fetch, which is the most likely early bug to
  // hit here (silently rejected requests, no console error unless DevTools
  // is open). img-src 'self' data: covers any inline/data-uri icons later.
  //
  // Scoped to just the configured backend origin (not a wildcard across all
  // local ports) -- the backend has no auth of its own, so keeping this
  // narrow limits what a compromised bundle could reach even in a
  // supply-chain/XSS scenario, instead of exposing every other local service
  // the user happens to be running.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${backendUrl}`,
  ].join("; ");

  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Renn Copilot</title>
  </head>
  <body>
    <script nonce="${nonce}">
      window.__RENN_BACKEND_URL__ = ${JSON.stringify(backendUrl)};
      window.__RENN_VIEW_MODE__ = ${JSON.stringify(mode)};
      window.__RENN_INITIAL_PAGE__ = ${JSON.stringify(initialPage ?? null)};
    </script>
    <div id="root"></div>
    <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
  </body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
