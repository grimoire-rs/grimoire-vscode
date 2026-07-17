// Shared webview HTML shell: strict CSP (nonce-only scripts), codicon font,
// per-view stylesheet and script from dist/webview.
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  bundle: 'sidebar' | 'details' | 'settings',
  rootAttrs = '',
  /** Server-side body inlined into #root so the first HTML parse shows structure
   *  before the script runs (details skeleton). Trusted markup — callers pass
   *  already-escaped render output. Empty for the sidebar. */
  bodyContent = '',
): string {
  const assetUri = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', ...parts));
  const scriptNonce = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src 'nonce-${scriptNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link id="vscode-codicon-stylesheet" rel="stylesheet" href="${assetUri('codicon.css')}">
  <link rel="stylesheet" href="${assetUri(`${bundle}.css`)}">
</head>
<body>
  <div id="root" ${rootAttrs}>${bodyContent}</div>
  <script nonce="${scriptNonce}" src="${assetUri(`${bundle}.js`)}"></script>
</body>
</html>`;
}
