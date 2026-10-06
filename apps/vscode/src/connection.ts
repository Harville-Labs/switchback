/**
 * The extension's connection to an engine: starting or attaching to it,
 * relaying its events to the chat, and forwarding the chat's actions.
 */
import { connectDaemon, formatLadder, SwitchbackClient, spawnEngine } from '@switchback/client';
import type {
  InitializeResult,
  RoutePreference,
  SessionRoles,
  SessionSummary,
} from '@switchback/protocol';
import * as vscode from 'vscode';
import { runChatCommand } from './chat-commands.ts';
import type { EditorContext } from './context.ts';
import { chooseEngine, type EngineBinary, findCli, probeVersion } from './engine-binary.ts';
import type { HostToWebview, WebviewToHost } from './messages.ts';
import { chooseAgent, chooseMode, chooseRole } from './pickers.ts';
import type { EditReview } from './review.ts';
import { VERSION } from './version.ts';

// biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code variable syntax, not a JS template.
const WORKSPACE_FOLDER_VAR = '${workspaceFolder}';

/** No engine to run: nothing bundled for this platform and no CLI installed. */
export class NoEngineError extends Error {}

/**
 * The engine to run: the user's setting if set, else the newer of the CLI and
 * the bundled binary (see engine-binary.ts). `${workspaceFolder}` is expanded.
 */
export async function resolveEngine(
  root: string,
  bundled: string | undefined,
): Promise<EngineBinary> {
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
    bundled: bundled
      ? { command: bundled, args: [], version: VERSION, source: 'bundled' }
      : undefined,
  });
  if (!chosen)
    throw new NoEngineError(
      'no switchback engine found: this platform has no bundled engine and the switchback CLI is not installed',
    );
  return { ...chosen, args: [...chosen.args, ...args] };
}

export class EngineConnection implements vscode.Disposable {
  client: SwitchbackClient | undefined;
  init: InitializeResult | undefined;
  session: SessionSummary | undefined;
  route: RoutePreference;
  context: EditorContext | undefined;
  /** Review of local edits for this window; undefined follows `review.mode`. */
  remoteReview: boolean | undefined = undefined;
  private readonly listeners = new Set<(m: HostToWebview) => void>();

  constructor(
    private readonly root: string,
    private readonly log: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem,
    private readonly review: EditReview,
    /** The platform binary this .vsix ships in `bin/`, if any. */
    private readonly bundled: string | undefined,
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
    const binary = await resolveEngine(this.root, this.bundled);
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
      if (event.type === 'route.decided' && event.sessionId === this.session?.id) {
        this.ladder =
          event.step !== undefined
            ? {
                step: event.step,
                steps: event.steps ?? 0,
                model: event.model.model,
                ...(event.stickyTurns !== undefined ? { stickyTurns: event.stickyTurns } : {}),
              }
            : undefined;
        this.updateStatus();
      }
      if (event.type === 'turn.completed' && event.sessionId === this.session?.id)
        void this.sendCommands();
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
    await this.sendRoles();
    await this.sendCommands();
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
    if (pick) await this.showSession(pick.id);
  }

  /** Make a saved session the chat's session and show its history. */
  async showSession(sessionId: string): Promise<void> {
    const c = this.client;
    if (!c) return;
    const { session, messages } = await c.request('session.get', { sessionId });
    this.session = session;
    this.updateStatus(session.costUsd);
    this.broadcast({ type: 'history', session, messages });
    await this.sendRoles();
  }

  async newSession(agent?: string) {
    if (!this.client) return;
    this.session = await this.client.request('session.create', agent ? { agent } : {});
    this.updateStatus(0);
    this.broadcast({ type: 'session', session: this.session });
    await this.sendRoles();
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
      await this.sendRoles();
      await this.sendCommands();
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
          attachments: [
            ...(m.attach && this.context ? this.context.attachments(m.attach) : []),
            ...(m.images ?? []).map((i) => ({ kind: 'image' as const, ...i })),
          ],
          ...(m.delivery ? { delivery: m.delivery } : {}),
        });
        return;
      case 'dequeue':
        await c.request('session.dequeue', { sessionId: this.session.id, id: m.id });
        return;
      case 'cancel':
        await c.request('session.cancel', { sessionId: this.session.id });
        return;
      case 'permission':
        await c.request('permission.respond', {
          requestId: m.requestId,
          decision: m.decision,
          ...(m.save ? { save: m.save } : {}),
        });
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
      case 'chooseRole':
        await chooseRole(this, m.role);
        return;
      case 'chooseAgent':
        await chooseAgent(this);
        return;
      case 'chooseMode':
        await chooseMode(this);
        return;
      case 'command':
        await runChatCommand(this, m.name, m.args);
        return;
    }
  }

  private lastCost = 0;
  private lastTier: string | undefined;
  /** Where the session's last call ran on the escalation ladder. */
  private ladder: Parameters<typeof formatLadder>[0];
  private updateStatus(cost?: number, tier?: string) {
    if (cost !== undefined) this.lastCost = cost;
    if (tier) this.lastTier = tier;
    const icon = this.lastTier === 'remote' ? '$(cloud)' : '$(home)';
    const ladder = formatLadder(this.ladder);
    this.setStatus(
      `${icon} ${this.route}${ladder ? ` · ${ladder}` : ''} · $${this.lastCost.toFixed(3)}`,
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

  async currentRoles(): Promise<SessionRoles | undefined> {
    if (!this.client || !this.session) return undefined;
    return this.client.request('session.roles', { sessionId: this.session.id });
  }

  /** Tell the chat which models fill the session's roles (after any session change). */
  async sendRoles() {
    this.ladder = undefined;
    const roles = await this.currentRoles().catch(() => undefined);
    if (roles) this.broadcast({ type: 'roles', roles });
  }

  /** Custom commands to the menu; the engine rescans their files on each list. */
  async sendCommands() {
    const commands = await this.client?.request('commands.list', {}).catch(() => undefined);
    if (commands) this.broadcast({ type: 'commands', commands });
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
