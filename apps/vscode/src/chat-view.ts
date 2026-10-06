import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from './messages.ts';

/** The chat webview: a strict CSP page that loads the bundled script and relays messages. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: WebviewToHost) => Promise<void> | undefined,
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const nonce = crypto.randomUUID().replaceAll('-', '');
    view.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m: WebviewToHost) => {
      this.onMessage(m)?.catch((err) =>
        vscode.window.showErrorMessage(`Switchback: ${(err as Error).message}`),
      );
    });
  }

  post(m: HostToWebview) {
    void this.view?.webview.postMessage(m);
  }
}
