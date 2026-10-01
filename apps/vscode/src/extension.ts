/**
 * VS Code extension host. A thin client: it spawns `switchback serve --stdio`,
 * relays engine events to the chat webview, and forwards user actions back.
 * All behavior (routing, tools, permissions, agents) lives in the engine.
 */

import { chmodSync, existsSync } from 'node:fs';
import { connectDaemon, SwitchbackClient, spawnEngine } from '@switchback/client';
import type {
  EngineEvent,
  InitializeResult,
  Message,
  RoutePreference,
  SessionSummary,
} from '@switchback/protocol';
import * as vscode from 'vscode';
import { type AttachChoice, EditorContext } from './context.ts';
import {
  chooseEngine,
  type EngineBinary,
  findCli,
  installerShell,
  probeVersion,
} from './engine-binary.ts';
import type { HostToWebview, WebviewToHost } from './messages.ts';
import { EditReview, PROPOSED_SCHEME } from './review.ts';

const VERSION = '0.5.0';
// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code variable syntax, not a JS template.
const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/** Set on activation when this .vsix ships a platform binary in `bin/`. */
let bundledBinary: string | undefined;

/** No engine to run: nothing bundled for this platform and no CLI installed. */
class NoEngineError extends Error {}

/**
 * The engine to run: the user's setting if set, else the newer of the CLI and
 * the bundled binary (see engine-binary.ts). `${workspaceFolder}` is expanded.
 */
async function resolveEngine(root: string): Promise<EngineBinary> {
  const cfg = vscode.workspace.getConfiguration('switchback');
  // VS Code does not expand variables in extension settings; support the common one.
  const expand = (v: string) => v.replaceAll(WORKSPACE_FOLDER_VAR, root);
  const args = cfg.get<string[]>('executableArgs', []).map(expand);
  const configured = cfg.get<string>('executablePath', '').trim();
  if (configured) {
    const command = expand(configured);
    return { command, args, version: await probeVersion(command, args), source: 'setting' };
  }
  const cli = await findCli();
  const chosen = chooseEngine({
    cli,
    bundled: bundledBinary
      ? { command: bundledBinary, args: [], version: VERSION, source: 'bundled' }
      : undefined,
  });
  if (!chosen)
    throw new NoEngineError(
      'no switchback engine found: this platform has no bundled engine and the switchback CLI is not installed',
    );
  return { ...chosen, args: [...chosen.args, ...args] };
}

class EngineConnection implements vscode.Disposable {
  client: SwitchbackClient | undefined;
  init: InitializeResult | undefined;
  session: SessionSummary | undefined;
  route: RoutePreference;
  context: EditorContext | undefined;
  private readonly listeners = new Set<(m: HostToWebview) => void>();

  constructor(
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem,
    private readonly review: EditReview,
  ) {
    this.route = vscode.workspace
      .getConfiguration('switchback')
      .get<RoutePreference>('defaultRoute', 'auto');
  }

  onMessage(listener: (m: HostToWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private broadcast(m: HostToWebview) {
    for (const l of this.listeners) l(m);
  }

  /** True when attached to the workspace's shared daemon (see switchback.sharedEngine). */
  shared = false;

  /** The binary this connection runs (set by start). */
  binary: EngineBinary | undefined;

  async start(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('switchback');
    const binary = await resolveEngine(this.root);
    this.binary = binary;
    const { command, args: baseArgs } = binary;
    this.log.appendLine(
      `engine: ${command} (${binary.source}${binary.version ? `, Switchback ${binary.version}` : ''})`,
    );
    // VS Code's own telemetry switch is an opt-out for Switchback too.
    const env = vscode.env.isTelemetryEnabled ? {} : { SWITCHBACK_TELEMETRY: '0' };
    let client: SwitchbackClient | undefined;
    let init: InitializeResult | undefined;
    // Share the engine with the TUI (and other windows) unless disabled; mock
    // engines are never shared.
    if (cfg.get<boolean>('sharedEngine', true) && !baseArgs.includes('--mock')) {
      if (!binary.version) {
        // The daemon is matched by version, so without one it can't be shared safely.
        this.log.appendLine(`${command} --version failed; not sharing the workspace engine`);
      } else {
        const shared = await connectDaemon({
          workspaceRoot: this.root,
          // The version of the binary that runs, which isn't the extension's
          // when it's the CLI or the executablePath setting.
          version: binary.version,
          client: { name: 'vscode', version: VERSION },
          spawn: { command, args: baseArgs },
          env: { ...process.env, ...env },
          log: (m) => this.log.appendLine(m),
        });
        if (shared.client) {
          ({ client, init } = shared);
          this.shared = true;
          this.log.appendLine('attached to the shared workspace engine');
        } else {
          this.log.appendLine(shared.reason);
          void vscode.window.showWarningMessage(shared.reason);
        }
      }
    }
    if (!client) {
      const args = [...baseArgs, 'serve', '--stdio'];
      this.log.appendLine(`starting: ${command} ${args.join(' ')} (cwd ${this.root})`);
      client = new SwitchbackClient(
        spawnEngine({ command, args, cwd: this.root, env, onStderr: (t) => this.log.append(t) }),
      );
    }
    const connected = client;
    connected.onClose(() => {
      if (this.client !== connected) return;
      this.client = undefined;
      this.setStatus('$(error) Switchback', 'Engine stopped. Run "Switchback: Restart Engine".');
      this.broadcast({
        type: 'disconnected',
        message: 'The switchback engine stopped. See "Switchback: Show Engine Logs".',
      });
    });
    client.on((event) => {
      this.broadcast({ type: 'event', event });
      if (event.type === 'usage.updated' && event.sessionId === this.session?.id)
        this.updateStatus(event.costUsd, event.tier);
      if (event.type === 'log') this.log.appendLine(`[${event.level}] ${event.message}`);
      if (
        event.type === 'permission.requested' &&
        event.proposed &&
        vscode.workspace
          .getConfiguration('switchback')
          .get<boolean>('reviewEditsInDiffEditor', true)
      ) {
        void this.review.show(this.root, event.requestId, event.proposed);
      }
      if (event.type === 'permission.resolved') void this.review.close(event.requestId);
      if (event.type === 'config.updated' && event.org) {
        void vscode.window.showInformationMessage(
          `${event.org.name} updated its Switchback policy${event.notes.length ? `: ${event.notes.join('; ')}` : '.'}`,
        );
      }
    });
    this.init = init ?? (await client.initialize({ name: 'vscode', version: VERSION }, this.root));
    this.client = client;
    this.session = await client.request('session.create', {});
    this.updateStatus(0);
    this.broadcast({ type: 'ready', init: this.init, session: this.session, route: this.route });
    if (this.context) this.broadcast({ type: 'context', state: this.context.state() });
  }

  /** Pick a saved session and show it in the chat. */
  async openSession(): Promise<void> {
    const c = this.client;
    if (!c) return;
    const sessions = await c.request('session.list', {});
    if (!sessions.length) {
      void vscode.window.showInformationMessage(
        'No saved Switchback sessions in this workspace yet.',
      );
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((x) => ({
        label: x.title || '(untitled)',
        description: `${x.agent} · $${x.costUsd.toFixed(3)}`,
        detail: new Date(x.updatedAt).toLocaleString(),
        id: x.id,
      })),
      { title: 'Switchback sessions', matchOnDescription: true },
    );
    if (!pick) return;
    const { session, messages } = await c.request('session.get', { sessionId: pick.id });
    this.session = session;
    this.updateStatus(session.costUsd);
    this.broadcast({ type: 'history', session, messages });
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

  post(m: HostToWebview) {
    this.broadcast(m);
  }

  async handle(m: WebviewToHost): Promise<void> {
    const c = this.client;
    // Editor-side actions that don't need the engine.
    switch (m.type) {
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied', 1500);
        return;
      case 'insert': {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          void vscode.window.showWarningMessage('Open a file to insert the code into.');
          return;
        }
        await editor.edit((b) => {
          for (const sel of editor.selections) b.replace(sel, m.text);
        });
        return;
      }
      case 'openLink':
        // Only web links leave the editor; anything else in model output is ignored.
        if (/^https?:\/\//i.test(m.href)) await vscode.env.openExternal(vscode.Uri.parse(m.href));
        return;
      case 'openHistory':
        await vscode.commands.executeCommand('switchback.openSession');
        return;
    }
    if (m.type === 'loaded') {
      if (this.init && this.session)
        this.broadcast({
          type: 'ready',
          init: this.init,
          session: this.session,
          route: this.route,
        });
      if (this.context) this.broadcast({ type: 'context', state: this.context.state() });
      return;
    }
    if (!c || !this.session) return;
    switch (m.type) {
      case 'prompt':
        await c.request('session.prompt', {
          sessionId: this.session.id,
          text: m.text,
          route: this.route,
          ...(this.remoteReview !== undefined ? { review: this.remoteReview } : {}),
          ...(m.attach && this.context ? { attachments: this.context.attachments(m.attach) } : {}),
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
      'Switchback: click to change routing',
    );
  }

  private setStatus(text: string, tooltip: string) {
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.show();
  }

  async usage() {
    if (!this.client) return;
    const u = await this.client.request('usage.get', { period: 'week' });
    this.broadcast({ type: 'usage', usage: u });
    const $ = (n: number) => `$${n.toFixed(2)}`;
    vscode.window.showInformationMessage(
      `Switchback, last 7 days: remote ${$(u.byTier.remote.costUsd)}, saved ~${$(u.estimatedSavingsUsd)} vs. all-remote. Today ${$(u.budget.spentTodayUsd)}${u.budget.dailyUsd ? ` of ${$(u.budget.dailyUsd)}` : ''}.`,
    );
  }

  /** Remote review of local edits for this window; undefined follows `review.mode`. */
  remoteReview: boolean | undefined = undefined;

  async chooseReview() {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'On',
          value: true,
          detail:
            'After a local model edits files, a remote model reviews the diff; the local model fixes what it finds.',
        },
        { label: 'Off', value: false, detail: 'No reviews in this window.' },
        {
          label: 'Follow config',
          value: undefined,
          detail: 'Use review.mode from your Switchback config.',
        },
      ],
      { title: 'Switchback: Remote Review of Local Edits' },
    );
    if (pick) this.remoteReview = pick.value;
  }

  async receipt() {
    if (!this.client || !this.session) return;
    const u = await this.client.request('usage.get', { sessionId: this.session.id });
    const total = u.byTier.remote.costUsd + u.estimatedSavingsUsd;
    const saved =
      u.referenceModel && u.estimatedSavingsUsd > 0
        ? ` Running it all on ${u.referenceModel} would have cost ~$${total.toFixed(2)}: saved ~$${u.estimatedSavingsUsd.toFixed(2)} (${Math.round((u.estimatedSavingsUsd / total) * 100)}%).`
        : '';
    vscode.window.showInformationMessage(
      `Switchback, this session (with subagents): $${u.byTier.remote.costUsd.toFixed(2)} on remote models.${saved}`,
    );
  }

  async compact() {
    if (!this.client || !this.session) return;
    const { compacted } = await this.client.request('session.compact', {
      sessionId: this.session.id,
    });
    if (!compacted) vscode.window.showInformationMessage('Switchback: nothing to compact yet.');
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
        .catch((err) => vscode.window.showErrorMessage(`Switchback: ${(err as Error).message}`));
    });
  }

  post(m: HostToWebview) {
    void this.view?.webview.postMessage(m);
  }
}

/** Returned from activate() for the integration tests; not a public API. */
export interface SwitchbackTestApi {
  connected(): boolean;
  pendingReviews(): string[];
  init(): InitializeResult | undefined;
  onEvent(listener: (event: EngineEvent) => void): vscode.Disposable;
  prompt(text: string, attach?: AttachChoice): Promise<void>;
  transcript(): Promise<Message[]>;
}

export async function activate(context: vscode.ExtensionContext): Promise<SwitchbackTestApi> {
  const bin = vscode.Uri.joinPath(
    context.extensionUri,
    'bin',
    process.platform === 'win32' ? 'switchback.exe' : 'switchback',
  ).fsPath;
  if (existsSync(bin)) {
    bundledBinary = bin;
    // .vsix is a zip; installs don't always preserve the executable bit.
    if (process.platform !== 'win32') {
      try {
        chmodSync(bin, 0o755);
      } catch {
        // Read-only install location; it was installed executable or spawn will say so.
      }
    }
  }
  const log = vscode.window.createOutputChannel('Switchback');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'switchback.setRoute';
  context.subscriptions.push(log, status);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const review = new EditReview();
  const editorContext = root
    ? new EditorContext((state) => engine?.post({ type: 'context', state }))
    : undefined;
  if (editorContext) context.subscriptions.push(editorContext);
  context.subscriptions.push(
    review,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, review),
  );
  const answerEdit = (decision: 'allow_once' | 'deny') => async (uri?: vscode.Uri) => {
    const requestId =
      review.requestIdOf(uri) ?? review.requestIdOf(vscode.window.activeTextEditor?.document.uri);
    if (!requestId) return;
    await engine?.handle({ type: 'permission', requestId, decision });
  };
  let engine: EngineConnection | undefined;
  const chat = new ChatViewProvider(context.extensionUri, () => engine);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('switchback.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const start = async () => {
    engine?.dispose();
    if (!root) {
      status.text = '$(circle-slash) Switchback';
      status.tooltip = 'Open a folder to use Switchback';
      status.show();
      return;
    }
    engine = new EngineConnection(root, log, status, review);
    engine.context = editorContext;
    engine.onMessage((m) => chat.post(m));
    try {
      await engine.start();
      // Local models are user-configured; nudge toward setup when there isn't one.
      // Never await a notification here: it resolves only when the user
      // clicks, and activation would hang until then.
      if (!engine.init?.models.some((m) => m.tier === 'local')) {
        void vscode.window
          .showInformationMessage(
            'Switchback has no local model configured, so every turn runs remotely.',
            'Set Up Models',
          )
          .then((pick) => {
            if (pick) void vscode.commands.executeCommand('switchback.runSetup');
          });
      }
    } catch (err) {
      const message = (err as Error).message;
      log.appendLine(`failed to start engine: ${message}`);
      if (err instanceof NoEngineError) {
        chat.post({
          type: 'disconnected',
          message:
            'Switchback needs its engine, the switchback CLI, which isn\'t installed. Run "Switchback: Install Terminal Command", or set "switchback.executablePath".',
        });
        void vscode.window
          .showErrorMessage(
            'Switchback needs the switchback CLI on this platform.',
            'Install Terminal Command',
            'Open Settings',
          )
          .then((pick) => {
            if (pick === 'Install Terminal Command')
              void vscode.commands.executeCommand('switchback.installCli');
            if (pick === 'Open Settings')
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'switchback.executablePath',
              );
          });
        return;
      }
      chat.post({
        type: 'disconnected',
        message: `Could not start switchback: ${message}. Check the "switchback.executablePath" setting.`,
      });
      void vscode.window
        .showErrorMessage('Switchback could not start its engine.', 'Open Settings', 'Show Logs')
        .then((pick) => {
          if (pick === 'Open Settings')
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'switchback.executablePath',
            );
          if (pick === 'Show Logs') log.show();
        });
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('switchback.newSession', () => engine?.newSession()),
    vscode.commands.registerCommand('switchback.openSession', () => engine?.openSession()),
    vscode.commands.registerCommand('switchback.acceptEdit', answerEdit('allow_once')),
    vscode.commands.registerCommand('switchback.rejectEdit', answerEdit('deny')),
    vscode.commands.registerCommand('switchback.cancel', () => engine?.handle({ type: 'cancel' })),
    vscode.commands.registerCommand('switchback.showUsage', () => engine?.usage()),
    vscode.commands.registerCommand('switchback.setReview', () => engine?.chooseReview()),
    vscode.commands.registerCommand('switchback.showReceipt', () =>
      engine?.receipt().catch((err: Error) => vscode.window.showErrorMessage(err.message)),
    ),
    vscode.commands.registerCommand('switchback.compact', () =>
      engine?.compact().catch((err: Error) => vscode.window.showErrorMessage(err.message)),
    ),
    vscode.commands.registerCommand('switchback.restartEngine', start),
    vscode.commands.registerCommand('switchback.installCli', () => {
      // The same installer as the website, so the CLI has one update path. It runs
      // where the extension runs (including remote hosts and containers); the
      // engine restarts afterwards to pick up the CLI if it's newer.
      const terminal = vscode.window.createTerminal({
        name: 'Install Switchback',
        ...installerShell(),
      });
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t !== terminal) return;
        sub.dispose();
        void start();
      });
      context.subscriptions.push(sub);
      terminal.show();
    }),
    vscode.commands.registerCommand('switchback.runSetup', async () => {
      if (!root) return;
      // Setup is interactive and shared with the CLI, so run `switchback init` in a terminal
      // and restart the engine when it closes to pick up the new config.
      let binary = engine?.binary;
      if (!binary) {
        try {
          binary = await resolveEngine(root);
        } catch (err) {
          void vscode.window.showErrorMessage((err as Error).message);
          return;
        }
      }
      const { command, args } = binary;
      const terminal = vscode.window.createTerminal({
        name: 'Switchback Setup',
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
    vscode.commands.registerCommand('switchback.showLogs', () => log.show()),
    vscode.commands.registerCommand('switchback.setRoute', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'auto', description: 'Local first, escalate to remote when needed' },
          { label: 'local', description: 'Only local models' },
          { label: 'remote', description: 'Only remote models' },
        ],
        { title: 'Switchback routing' },
      );
      if (pick) engine?.setRoute(pick.label as RoutePreference);
    }),
    vscode.commands.registerCommand('switchback.askAboutSelection', async () => {
      if (!root || !editorContext) return;
      engine?.post({ type: 'context', state: editorContext.state() });
      await vscode.commands.executeCommand('switchback.chat.focus');
      engine?.post({ type: 'attachSelection' });
    }),
    { dispose: () => engine?.dispose() },
  );

  await start();

  return {
    connected: () => !!engine?.client,
    pendingReviews: () => review.pending(),
    init: () => engine?.init,
    onEvent: (listener) =>
      engine?.onMessage((m) => {
        if (m.type === 'event') listener(m.event);
      }) ?? new vscode.Disposable(() => {}),
    prompt: async (text, attach) => {
      await engine?.handle({ type: 'prompt', text, ...(attach ? { attach } : {}) });
    },
    transcript: async () => {
      const c = engine?.client;
      const id = engine?.session?.id;
      return c && id ? (await c.request('session.get', { sessionId: id })).messages : [];
    },
  };
}

export function deactivate() {}
