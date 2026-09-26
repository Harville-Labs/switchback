/**
 * VS Code extension host. A thin client: it spawns `harness serve --stdio`,
 * relays engine events to the chat webview, and forwards user actions back.
 * All behavior (routing, tools, permissions, agents) lives in the engine.
 */
import { HarnessClient, spawnEngine } from '@harness/client';
import type { InitializeResult, RoutePreference, SessionSummary } from '@harness/protocol';
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from './messages.ts';

const VERSION = '0.1.0';
// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code variable syntax, not a JS template.
const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/** The configured harness executable and leading args, with `${workspaceFolder}` expanded. */
function harnessCommand(root: string): { command: string; args: string[] } {
  const cfg = vscode.workspace.getConfiguration('harness');
  // VS Code does not expand variables in extension settings; support the common one.
  const expand = (v: string) => v.replaceAll(WORKSPACE_FOLDER_VAR, root);
  return {
    command: expand(cfg.get<string>('executablePath', 'harness')),
    args: cfg.get<string[]>('executableArgs', []).map(expand),
  };
}

class EngineConnection implements vscode.Disposable {
  client: HarnessClient | undefined;
  init: InitializeResult | undefined;
  session: SessionSummary | undefined;
  route: RoutePreference;
  private readonly listeners = new Set<(m: HostToWebview) => void>();

  constructor(
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem,
  ) {
    this.route = vscode.workspace
      .getConfiguration('harness')
      .get<RoutePreference>('defaultRoute', 'auto');
  }

  onMessage(listener: (m: HostToWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private broadcast(m: HostToWebview) {
    for (const l of this.listeners) l(m);
  }

  async start(): Promise<void> {
    const { command, args: baseArgs } = harnessCommand(this.root);
    const args = [...baseArgs, 'serve', '--stdio'];
    this.log.appendLine(`starting: ${command} ${args.join(' ')} (cwd ${this.root})`);
    const transport = spawnEngine({
      command,
      args,
      cwd: this.root,
      onStderr: (t) => this.log.append(t),
    });
    const client = new HarnessClient(transport);
    transport.onClose(() => {
      if (this.client !== client) return;
      this.client = undefined;
      this.setStatus('$(error) Harness', 'Engine stopped. Run "Harness: Restart Engine".');
      this.broadcast({
        type: 'disconnected',
        message: 'The harness engine stopped. See "Harness: Show Engine Logs".',
      });
    });
    client.on((event) => {
      this.broadcast({ type: 'event', event });
      if (event.type === 'usage.updated' && event.sessionId === this.session?.id)
        this.updateStatus(event.costUsd, event.tier);
      if (event.type === 'log') this.log.appendLine(`[${event.level}] ${event.message}`);
    });
    this.init = await client.initialize({ name: 'vscode', version: VERSION }, this.root);
    this.client = client;
    this.session = await client.request('session.create', {});
    this.updateStatus(0);
    this.broadcast({ type: 'ready', init: this.init, session: this.session, route: this.route });
  }

  async newSession(agent?: string) {
    if (!this.client) return;
    this.session = await this.client.request('session.create', agent ? { agent } : {});
    this.updateStatus(0);
    this.broadcast({ type: 'session', session: this.session });
  }

  setRoute(route: RoutePreference) {
    this.route = route;
    this.updateStatus();
    this.broadcast({ type: 'route', route });
  }

  prefill(text: string) {
    this.broadcast({ type: 'prefill', text });
  }

  async handle(m: WebviewToHost): Promise<void> {
    const c = this.client;
    if (m.type === 'loaded') {
      if (this.init && this.session)
        this.broadcast({
          type: 'ready',
          init: this.init,
          session: this.session,
          route: this.route,
        });
      return;
    }
    if (!c || !this.session) return;
    switch (m.type) {
      case 'prompt':
        await c.request('session.prompt', {
          sessionId: this.session.id,
          text: m.text,
          route: this.route,
        });
        return;
      case 'cancel':
        await c.request('session.cancel', { sessionId: this.session.id });
        return;
      case 'permission':
        await c.request('permission.respond', { requestId: m.requestId, decision: m.decision });
        return;
      case 'escalation':
        await c.request('escalation.respond', { requestId: m.requestId, approve: m.approve });
        return;
      case 'setRoute':
        this.setRoute(m.route);
        return;
      case 'newSession':
        await this.newSession(m.agent);
        return;
    }
  }

  private lastCost = 0;
  private lastTier: string | undefined;
  private updateStatus(cost?: number, tier?: string) {
    if (cost !== undefined) this.lastCost = cost;
    if (tier) this.lastTier = tier;
    const icon = this.lastTier === 'remote' ? '$(cloud)' : '$(home)';
    this.setStatus(
      `${icon} ${this.route} · $${this.lastCost.toFixed(3)}`,
      'Harness: click to change routing',
    );
  }

  private setStatus(text: string, tooltip: string) {
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.show();
  }

  async usage() {
    if (!this.client) return;
    const u = await this.client.request('usage.get', {});
    this.broadcast({ type: 'usage', usage: u });
    const $ = (n: number) => `$${n.toFixed(2)}`;
    vscode.window.showInformationMessage(
      `Harness this month: remote ${$(u.byTier.remote.costUsd)}, saved ~${$(u.estimatedSavingsUsd)} vs. all-remote. Today ${$(u.budget.spentTodayUsd)}${u.budget.dailyUsd ? ` of ${$(u.budget.dailyUsd)}` : ''}.`,
    );
  }

  dispose() {
    const c = this.client;
    this.client = undefined;
    if (c)
      c.request('shutdown', {})
        .finally(() => c.close())
        .catch(() => c.close());
  }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly engine: () => EngineConnection | undefined,
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
      this.engine()
        ?.handle(m)
        .catch((err) => vscode.window.showErrorMessage(`Harness: ${(err as Error).message}`));
    });
  }

  post(m: HostToWebview) {
    void this.view?.webview.postMessage(m);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Harness');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'harness.setRoute';
  context.subscriptions.push(log, status);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let engine: EngineConnection | undefined;
  const chat = new ChatViewProvider(context.extensionUri, () => engine);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('harness.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const start = async () => {
    engine?.dispose();
    if (!root) {
      status.text = '$(circle-slash) Harness';
      status.tooltip = 'Open a folder to use Harness';
      status.show();
      return;
    }
    engine = new EngineConnection(root, log, status);
    engine.onMessage((m) => chat.post(m));
    try {
      await engine.start();
      // Local models are user-configured; nudge toward setup when there isn't one.
      if (!engine.init?.models.some((m) => m.tier === 'local')) {
        const pick = await vscode.window.showInformationMessage(
          'Harness has no local model configured, so every turn runs remotely.',
          'Set Up Models',
        );
        if (pick) vscode.commands.executeCommand('harness.runSetup');
      }
    } catch (err) {
      const message = (err as Error).message;
      log.appendLine(`failed to start engine: ${message}`);
      chat.post({
        type: 'disconnected',
        message: `Could not start harness: ${message}. Check the "harness.executablePath" setting.`,
      });
      const pick = await vscode.window.showErrorMessage(
        'Harness could not start its engine.',
        'Open Settings',
        'Show Logs',
      );
      if (pick === 'Open Settings')
        vscode.commands.executeCommand('workbench.action.openSettings', 'harness.executablePath');
      if (pick === 'Show Logs') log.show();
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('harness.newSession', () => engine?.newSession()),
    vscode.commands.registerCommand('harness.cancel', () => engine?.handle({ type: 'cancel' })),
    vscode.commands.registerCommand('harness.showUsage', () => engine?.usage()),
    vscode.commands.registerCommand('harness.restartEngine', start),
    vscode.commands.registerCommand('harness.runSetup', () => {
      if (!root) return;
      // Setup is interactive and shared with the CLI, so run `harness init` in a terminal
      // and restart the engine when it closes to pick up the new config.
      const { command, args } = harnessCommand(root);
      const terminal = vscode.window.createTerminal({
        name: 'Harness Setup',
        cwd: root,
        shellPath: command,
        shellArgs: [...args, 'init'],
      });
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t !== terminal) return;
        sub.dispose();
        void start();
      });
      context.subscriptions.push(sub);
      terminal.show();
    }),
    vscode.commands.registerCommand('harness.showLogs', () => log.show()),
    vscode.commands.registerCommand('harness.setRoute', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'auto', description: 'Local first, escalate to remote when needed' },
          { label: 'local', description: 'Only local models' },
          { label: 'remote', description: 'Only remote models' },
        ],
        { title: 'Harness routing' },
      );
      if (pick) engine?.setRoute(pick.label as RoutePreference);
    }),
    vscode.commands.registerCommand('harness.askAboutSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !root) return;
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const { start: s, end } = editor.selection;
      const code = editor.document.getText(editor.selection);
      await vscode.commands.executeCommand('harness.chat.focus');
      engine?.prefill(`In ${rel}:${s.line + 1}-${end.line + 1}:\n\`\`\`\n${code}\n\`\`\`\n`);
    }),
    { dispose: () => engine?.dispose() },
  );

  await start();
}

export function deactivate() {}
