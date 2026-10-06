/**
 * The engine: owns sessions, routing, providers, tools, permissions, and
 * subagents. Clients (TUI, VS Code, headless) drive it only through the
 * protocol methods mirrored here and observe it only through `EngineEvent`s.
 *
 * The parts live in their own modules and borrow what they need through an
 * `EngineHost`: tool calls (`tool-runner.ts`), review (`review-runner.ts`),
 * compaction (`compactor.ts`), subagents (`subagents.ts`), external runtimes
 * (`external-runtime.ts`), models and providers (`model-directory.ts`), and
 * the agent loop itself (`agent-loop.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentSummary,
  type Attachment,
  type CheckpointInfo,
  type EngineEvent,
  ErrorCode,
  type InitializeResult,
  type McpListResult,
  type PermissionDecision,
  type PermissionMode,
  type PermissionsListResult,
  PROTOCOL_VERSION,
  type RoutePreference,
  RpcError,
  type SessionGetResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionRewindParams,
  type SessionRewindResult,
  type SessionRoles,
  type SessionSetRolesParams,
  type SessionSummary,
  type ShellInfo,
  type UsagePeriod,
  type UsageReport,
} from '@switchback/protocol';
import type { Price } from '@switchback/providers';
import { budgetReached, Router, roleAliases } from '@switchback/router';
import { AgentLoop } from './agent-loop.ts';
import { type AgentDefinition, loadAgents, summarize } from './agents.ts';
import { type AgentSpec, draftAgentPrompt } from './authoring.ts';
import { Checkpoints, FileCheckpointStore, MemoryCheckpointStore } from './checkpoints.ts';
import { Compactor } from './compactor.ts';
import { type SwitchbackConfig, tierOfModel } from './config.ts';
import type { EngineOptions } from './engine-options.ts';
import { ExternalRuntimes } from './external-runtime.ts';
import { HookRunner } from './hooks/runner.ts';
import { TurnHooks } from './hooks/turn-hooks.ts';
import { type LedgerEntry, UsageLedger } from './ledger.ts';
import { type EngineHost, type LiveSession, scope, type TurnResult } from './live-session.ts';
import { McpHub } from './mcp/hub.ts';
import { ModelDirectory } from './model-directory.ts';
import type { OrgStatus } from './org/policy.ts';
import { projectPaths, switchbackPaths } from './paths.ts';
import { PermissionGate } from './permissions/gate.ts';
import { assertModeAllowed } from './permissions/modes.ts';
import { configRules, type SourcedRule } from './permissions/policy.ts';
import { type PrivatePathMatcher, privatePathMatcher } from './privacy.ts';
import { ReviewRunner } from './review-runner.ts';
import { SessionControls } from './session-controls.ts';
import { SessionRegistry } from './session-registry.ts';
import { changeRoles, effectiveRoles, rolesLayer } from './session-roles.ts';
import { writeConfigLayer } from './setup.ts';
import { FileSessionStore, MemorySessionStore, type SessionHeader } from './store.ts';
import { Subagents } from './subagents.ts';
import { systemPrompt } from './system-prompt.ts';
import { ToolRunner } from './tool-runner.ts';
import { CommandRunner, shellOf } from './tools/process.ts';
import { BashSandbox } from './tools/sandbox.ts';
import { type TurnOptions, TurnRunner } from './turn-runner.ts';
import { UsageRecorder } from './usage-recorder.ts';
import type { Worktree } from './worktree.ts';

export type { EngineOptions } from './engine-options.ts';

export const ENGINE_VERSION = '0.6.0';

/** The model whose prices define "saved": the first remote model in role order. */
function referenceModel(config: SwitchbackConfig): string | undefined {
  const alias = roleAliases(config.routing).find((a) => tierOfModel(config, a) === 'remote');
  return alias ? config.models[alias]?.model : undefined;
}

function newSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export class Engine {
  private listeners = new Set<(event: EngineEvent) => void>();
  private readonly sessions: SessionRegistry;
  private router: Router;
  private readonly ledger: UsageLedger;
  private agents: Map<string, AgentDefinition>;
  private agentErrorsSeen = new Set<string>();
  private readonly now: () => Date;
  private mcp: McpHub | undefined;
  private privateMatcher: { key: string; matches: PrivatePathMatcher | undefined } | undefined;
  private readonly host: EngineHost;
  private readonly models: ModelDirectory;
  private readonly gate: PermissionGate;
  private readonly commands: CommandRunner;
  private readonly hooks: HookRunner;
  private readonly tools: ToolRunner;
  private readonly reviews: ReviewRunner;
  private readonly compactor: Compactor;
  private readonly subagents: Subagents;
  private readonly external: ExternalRuntimes;
  private readonly agentLoop: AgentLoop;
  private readonly turns: TurnRunner;
  private readonly controls: SessionControls;

  constructor(private readonly options: EngineOptions) {
    const { config } = options;
    this.now = options.now ?? (() => new Date());
    this.models = new ModelDirectory(config, options.providers, (e) => this.emit(e), this.now);
    this.router = this.newRouter(config.routing);
    this.ledger = new UsageLedger(
      options.ledgerFile,
      options.prices ?? {},
      referenceModel(config),
      options.now,
    );
    this.sessions = new SessionRegistry(
      options.store ?? new MemorySessionStore(),
      () => this.options.config,
      this.now,
    );
    this.agents = options.agents ?? loadAgents([]).agents;
    this.mcp = this.startMcp(config);
    const recorder = new UsageRecorder(this.ledger, (e) => this.emit(e), this.now);
    this.host = {
      config: () => this.options.config,
      org: () => this.options.org,
      emit: (e) => this.emit(e),
      notify: (level, message) => this.notify(level, message),
      append: (s, m) => this.sessions.append(s, m),
      rolesOf: (s) => this.rolesOf(s),
      remoteBlocked: (s) => this.remoteBlocked(s),
      recordUsage: (s, tier, model, usage, meta) => recorder.record(s, tier, model, usage, meta),
      rootOf: (s) => this.rootOf(s),
      top: (s) => this.sessions.top(s),
      session: (id) => this.sessions.get(id),
      privatePaths: () => this.privatePaths(),
    };
    this.compactor = new Compactor(this.host, this.models);
    this.controls = new SessionControls(this.host, {
      sessions: this.sessions,
      checkpoints: new Checkpoints(options.checkpoints ?? new MemoryCheckpointStore()),
      gate: () => this.gate,
      commands: () => this.commands,
      summary: (s) => this.summary(s),
      newSessionId,
      now: this.now,
    });
    const paths = switchbackPaths();
    const dataDir = options.dataDir ?? paths.dataDir;
    this.hooks = new HookRunner({
      hooks: () => this.options.config.hooks,
      workspaceRoot: options.workspaceRoot,
      argv: (command) => shellOf(this.options.config.bash).argv(command),
      notify: (level, message) => this.notify(level, message),
    });
    this.commands = new CommandRunner(
      () => this.options.config.bash,
      (shell) => this.emit({ type: 'shell.updated', sessionId: shell.sessionId, shell }),
      options.sandbox === false
        ? undefined
        : {
            runtime: options.sandbox ?? new BashSandbox(dataDir),
            context: (cwd) => ({
              workspaceRoot: options.workspaceRoot,
              sessionRoot: cwd,
              switchbackDirs: [paths.configDir, dataDir],
              rules: this.gate.policy().list(),
            }),
            notice: (message) => this.notify('warn', message),
          },
    );
    // Collaborators call each other only after construction, through these closures.
    this.gate = new PermissionGate(this.host, {
      interaction: () => this.options.interaction ?? 'prompt',
      rules: () => (this.options.rules ??= configRules(this.options.config)),
      mode: (s) => this.controls.modeOf(s),
      // exit_plan_mode's result tells the model about the change itself.
      setMode: (s, mode) => this.controls.changeMode(this.sessions.top(s), mode, true),
      saveTo: {
        project: projectPaths(options.workspaceRoot).localConfigFile,
        user: options.userConfigFile ?? switchbackPaths().configFile,
      },
    });
    this.tools = new ToolRunner(this.host, this.gate, {
      commands: this.commands,
      hooks: this.hooks,
      hookPayload: (s) => this.hookPayload(s),
      runSubagent: (parent, agent, prompt, description, signal, opts) =>
        this.subagents.run(parent, agent, prompt, description, signal, opts),
      noteEdit: (s, path, writer) => {
        this.reviews.noteEdit(s, path, writer);
        this.controls.noteCheckpoint(s, path);
      },
    });
    this.external = new ExternalRuntimes(this.host, {
      injected: options.runtimes,
      invocationBudget: (s) => this.subagents.invocationBudget(s),
      checkPermission: (s, tool, input, ctx, signal) =>
        this.gate.check(s, tool, input, ctx, signal),
    });
    this.subagents = new Subagents(this.host, {
      agent: (name) => this.agents.get(name),
      createSession: (p) => this.sessions.live(this.createSession(p).id),
      runTurn: (s, text, route, signal, opts) =>
        this.runTurn(s, text, route, undefined, signal, [], opts),
      runExternal: (s, agent, prompt, signal) => this.external.run(s, agent, prompt, signal),
      sessionCost: (id) => this.ledger.sessionCost(id).costUsd,
      children: (id) => this.sessions.children(id),
      workspaceRoot: options.workspaceRoot,
      dataDir: options.dataDir,
    });
    this.reviews = new ReviewRunner(this.host, this.models, (s, route, turnId, signal) =>
      this.agentLoop.run(s, route, turnId, signal),
    );
    this.agentLoop = new AgentLoop(this.host, {
      models: this.models,
      tools: this.tools,
      compactor: this.compactor,
      subagents: this.subagents,
      ledger: this.ledger,
      router: (s) => this.routerFor(s),
      agent: (name) => this.agents.get(name),
      agents: () => [...this.agents.values()],
      mcp: () => this.mcp,
      interaction: () => this.options.interaction ?? 'prompt',
      beforeStep: (s, turnId) => {
        this.subagents.drainInbox(s);
        return s.depth === 0 ? this.turns.deliverQueued(s, turnId) : Promise.resolve();
      },
    });
    this.turns = new TurnRunner(this.host, {
      loop: this.agentLoop,
      hooks: new TurnHooks(this.hooks, (s) => this.hookPayload(s)),
      reviews: this.reviews,
      mode: (s) => this.controls.modeOf(s),
      checkpoint: (s, turnId, prompt) => this.controls.beginCheckpoint(s, turnId, prompt),
    });
  }

  private startMcp(config: SwitchbackConfig): McpHub | undefined {
    if (!Object.keys(config.mcpServers).length) return undefined;
    return new McpHub(config.mcpServers, this.options.workspaceRoot, (level, message) =>
      this.notify(level, message),
    );
  }

  private newRouter(routing: SwitchbackConfig['routing']): Router {
    return new Router(routing, (alias) => this.models.info(alias));
  }

  /** `mcp.list`: waits briefly for servers still connecting. */
  async mcpStatus(): Promise<McpListResult> {
    if (this.mcp) await Promise.race([this.mcp.ready, Bun.sleep(5_000)]);
    return {
      servers: [
        ...(this.mcp?.status() ?? []),
        ...(this.options.untrustedMcp ?? []).map((u) => ({
          name: u.name,
          state: 'untrusted' as const,
          tools: 0,
          error: `defined in ${u.source}; run \`switchback mcp trust\` to allow it`,
        })),
      ],
    };
  }

  /** Build an engine from disk: agents, instructions, persistent store, and ledger. */
  static fromWorkspace(
    workspaceRoot: string,
    config: SwitchbackConfig,
    extra: Partial<EngineOptions> = {},
  ): { engine: Engine; agentErrors: string[] } {
    const hp = switchbackPaths();
    const pp = projectPaths(workspaceRoot);
    const agentDirs: EngineOptions['agentDirs'] = [
      { dir: hp.agentsDir, source: 'user' },
      { dir: pp.agentsDir, source: 'project' },
    ];
    const { agents, errors } = loadAgents(agentDirs);
    const instructions = existsSync(pp.instructionsFile)
      ? readFileSync(pp.instructionsFile, 'utf8')
      : undefined;
    const engine = new Engine({
      workspaceRoot,
      config,
      agents,
      agentDirs,
      ...(instructions ? { instructions } : {}),
      ledgerFile: hp.usageFile,
      store: new FileSessionStore(hp.sessionsDir),
      checkpoints: new FileCheckpointStore(join(hp.dataDir, 'checkpoints')),
      ...extra,
    });
    return { engine, agentErrors: errors };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Surface a diagnostic to clients (as a `log` event). */
  notify(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', level, message });
  }

  private emit(event: EngineEvent): void {
    for (const l of this.listeners) l(event);
    // Notification hooks: Switchback is waiting on the user.
    if (event.type !== 'permission.requested' && event.type !== 'escalation.requested') return;
    if (!this.hooks.has('Notification')) return;
    const message =
      event.type === 'permission.requested'
        ? `Switchback needs your permission: ${event.summary}`
        : `Switchback asks to escalate to ${event.target.model}`;
    void this.hooks.run('Notification', { session_id: event.sessionId, message });
  }

  /** What every hook hears about the session. */
  private hookPayload(s: LiveSession): Record<string, unknown> {
    return { session_id: s.header.id, permission_mode: this.controls.modeOf(s) };
  }

  // -------------------------------------------------------------------------
  // Protocol surface
  // -------------------------------------------------------------------------

  initialize(): InitializeResult {
    const { org } = this.options;
    return {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      workspaceRoot: this.options.workspaceRoot,
      models: Object.entries(this.options.config.models).map(([alias, m]) => ({
        alias,
        ref: { provider: m.provider, model: m.model },
        tier: this.models.tierOfProvider(m.provider),
      })),
      agents: this.listAgents(),
      ...(org ? { org: { id: org.id, name: org.name, version: org.version } } : {}),
    };
  }

  listAgents(): AgentSummary[] {
    this.refreshAgents();
    return [...this.agents.values()].map(summarize);
  }

  /** Pick up agent files added or changed since startup (a few small files). */
  private refreshAgents(): void {
    const dirs = this.options.agentDirs;
    if (!dirs) return;
    const { agents, errors } = loadAgents(dirs);
    this.agents = agents;
    for (const e of errors) {
      if (this.agentErrorsSeen.has(e)) continue;
      this.agentErrorsSeen.add(e);
      this.notify('warn', `agent definition skipped: ${e}`);
    }
  }

  createSession(params: {
    agent?: string;
    title?: string;
    parentId?: string;
    worktree?: Worktree;
    permissionMode?: PermissionMode;
    instructions?: string;
  }): SessionSummary {
    const agentName = params.agent ?? this.options.config.defaultAgent;
    if (!params.parentId) this.refreshAgents();
    const agent = this.agents.get(agentName);
    if (!agent) throw new RpcError(ErrorCode.InvalidParams, `unknown agent "${agentName}"`);
    if (params.permissionMode) assertModeAllowed(params.permissionMode, this.options.org);
    const now = this.now().toISOString();
    const wt = params.worktree;
    const header: SessionHeader = {
      id: newSessionId(),
      title: params.title ?? '',
      agent: agent.name,
      ...(params.parentId ? { parentId: params.parentId } : {}),
      workspaceRoot: this.options.workspaceRoot,
      ...(wt ? { worktree: { path: wt.path, root: wt.root, branch: wt.branch } } : {}),
      createdAt: now,
      system: systemPrompt({
        agent,
        workspaceRoot: this.options.workspaceRoot,
        root: wt?.root ?? this.options.workspaceRoot,
        shell: shellOf(this.options.config.bash).name,
        ...(this.options.instructions ? { project: this.options.instructions } : {}),
        ...(params.instructions ? { session: params.instructions } : {}),
      }),
    };
    const live = this.sessions.create(
      header,
      params.permissionMode && !params.parentId ? { mode: params.permissionMode } : {},
    );
    return this.summary(live);
  }

  /** Top-level sessions in this workspace, most recently updated first. */
  listSessions(): SessionSummary[] {
    return this.sessions
      .stored()
      .filter(
        ({ header }) => !header.parentId && header.workspaceRoot === this.options.workspaceRoot,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ header, updatedAt }) => this.summaryOf(header, updatedAt));
  }

  getSession(sessionId: string): SessionGetResult {
    const s = this.sessions.live(sessionId);
    return { session: this.summary(s), messages: s.messages };
  }

  /** A session's effective roles: its own changes over the config. */
  roles(sessionId: string): SessionRoles {
    return this.rolesOf(this.sessions.live(sessionId));
  }

  /**
   * Change a session's roles (ADR 0015). With `save`, write them to the user
   * config as the default for new sessions. Keys an organization enforces
   * can't be changed.
   */
  setRoles(params: SessionSetRolesParams): SessionRoles & { savedTo?: string } {
    const s = this.sessions.top(this.sessions.live(params.sessionId));
    s.roles = changeRoles(s.roles, params, this.options.config, this.options.org);
    const result = this.rolesOf(s);
    let savedTo: string | undefined;
    if (params.save) {
      const file = this.options.userConfigFile ?? switchbackPaths().configFile;
      // Checked above against the merged config; the models may live in another file.
      writeConfigLayer(file, rolesLayer(result), { references: false });
      savedTo = file;
    }
    this.emit({ type: 'roles.updated', ...scope(s), roles: result });
    return { ...result, ...(savedTo ? { savedTo } : {}) };
  }

  /** Start a turn and return immediately; progress arrives as events. */
  prompt(params: SessionPromptParams): SessionPromptResult {
    const { sessionId, ...rest } = params;
    return this.turns.start(this.sessions.live(sessionId), rest);
  }

  /** `session.checkpoints`. */
  listCheckpoints(sessionId: string): CheckpointInfo[] {
    return this.controls.listCheckpoints(sessionId);
  }

  /** `session.rewind`. */
  rewind(params: SessionRewindParams): SessionRewindResult {
    return this.controls.rewind(params);
  }

  /** `session.dequeue`. */
  dequeue(sessionId: string, id: string): { removed: boolean } {
    return { removed: this.turns.dequeue(this.sessions.live(sessionId), id) };
  }

  /** Run a full user turn to completion. Used directly by headless mode and subagents. */
  runTurn(
    s: LiveSession | string,
    text: string,
    route: RoutePreference = 'auto',
    turnId = `turn_${crypto.randomUUID().slice(0, 8)}`,
    parentSignal?: AbortSignal,
    extra: Attachment[] = [],
    options: TurnOptions = {},
  ): Promise<TurnResult> {
    const session = typeof s === 'string' ? this.sessions.live(s) : s;
    return this.turns.run(session, text, route, turnId, parentSignal, extra, options);
  }

  /** Cancel the running turn and every background subagent the session started. */
  cancel(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const hadWork = !!s.controller || s.background.size > 0;
    s.controller?.abort();
    s.bgController?.abort();
    s.bgController = undefined;
    s.inbox.length = 0;
    this.turns.clearQueue(s);
    return hadWork;
  }

  respondPermission(
    requestId: string,
    decision: PermissionDecision,
    save?: 'project' | 'user',
  ): void {
    this.gate.prompts.answer(requestId, { decision, ...(save ? { save } : {}) });
  }

  /** `session.setMode`. */
  setMode(sessionId: string, mode: PermissionMode): { mode: PermissionMode } {
    return this.controls.setMode(sessionId, mode);
  }

  /** `permissions.list`. */
  permissions(sessionId?: string): Promise<PermissionsListResult> {
    return this.controls.permissions(sessionId);
  }

  respondEscalation(requestId: string, approve: boolean): void {
    this.agentLoop.escalations.answer(requestId, approve);
  }

  /**
   * Swap in a new configuration without restarting (organization policy
   * updates, config file edits). Running turns pick it up at their next model
   * call; providers whose settings didn't change keep their state.
   */
  applyConfig(next: {
    config: SwitchbackConfig;
    prices?: Record<string, Price>;
    org?: OrgStatus;
    untrustedMcp?: { name: string; source: string }[];
    rules?: SourcedRule[];
  }): void {
    this.models.apply(next.config);
    this.gate.revokeGrants();
    this.options.rules = next.rules;
    if (JSON.stringify(next.config.mcpServers) !== JSON.stringify(this.options.config.mcpServers)) {
      void this.mcp?.close();
      this.mcp = this.startMcp(next.config);
    }
    this.options.config = next.config;
    if (next.org) this.options.org = next.org;
    if (next.untrustedMcp) this.options.untrustedMcp = next.untrustedMcp;
    this.router = this.newRouter(next.config.routing);
    this.ledger.setPricing(next.prices ?? {}, referenceModel(next.config));
    const org = next.org;
    this.emit({
      type: 'config.updated',
      ...(org ? { org: { id: org.id, name: org.name, version: org.version } } : {}),
      notes: org?.notes ?? [],
    });
  }

  /** Ledger entries recorded after `sinceIso`, for usage reporting. */
  usageEntriesSince(sinceIso: string): LedgerEntry[] {
    return this.ledger.entriesSince(sinceIso);
  }

  usage(period?: UsagePeriod, sessionId?: string): UsageReport {
    return this.ledger.report(
      this.options.config.routing.budget,
      period,
      sessionId ? this.sessions.tree(sessionId) : undefined,
    );
  }

  /** `session.compact`: compact now, whatever the prompt size. */
  async compactSession(sessionId: string): Promise<{ compacted: boolean }> {
    const s = this.sessions.live(sessionId);
    if (s.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is running a turn');
    const controller = new AbortController();
    s.controller = controller;
    try {
      await this.models.refreshHealth(controller.signal);
      const { specsJson } = this.agentLoop.toolSetup(s);
      return { compacted: await this.compactor.compact(s, specsJson, controller.signal, true) };
    } finally {
      s.controller = undefined;
    }
  }

  /**
   * Draft a system prompt for a new agent (`switchback agents new`). A single
   * tool-free call on the same model choice as summaries: local when
   * reachable, remote only when routing and budget allow.
   */
  async draftAgentPrompt(spec: AgentSpec): Promise<string> {
    const controller = new AbortController();
    await this.models.refreshHealth(controller.signal);
    const model = this.compactor.summarizerModel(0);
    const provider = model && this.models.provider(model.ref.provider);
    if (!model || !provider) throw new Error('no model is available to draft the prompt');
    const draft = await draftAgentPrompt(provider, model.ref.model, spec, controller.signal);
    this.ledger.record('authoring', model.tier, model.ref, draft.usage, {
      rule: 'authoring',
      agent: spec.name,
    });
    if (!draft.text) throw new Error('the model returned an empty draft');
    return draft.text;
  }

  /** `shells.list`. */
  shells(sessionId?: string): ShellInfo[] {
    return this.commands.list(sessionId);
  }

  /** `shells.kill`. */
  killShell(shellId: string): ShellInfo {
    return this.commands.kill(shellId);
  }

  async shutdown(): Promise<void> {
    await this.commands.close();
    for (const s of this.sessions.inMemory()) {
      s.controller?.abort();
      s.bgController?.abort();
    }
    await this.mcp?.close();
  }

  /** Whether any session has a turn in progress (daemons stay up while busy). */
  busy(): boolean {
    for (const s of this.sessions.inMemory()) if (s.controller || s.background.size) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Sessions and what the collaborators borrow (`EngineHost`)
  // -------------------------------------------------------------------------

  private rolesOf(s: LiveSession): SessionRoles {
    return effectiveRoles(this.options.config, this.sessions.top(s).roles);
  }

  /** The router for a session: the config's, or one with the session's own roles. */
  private routerFor(s: LiveSession): Router {
    const own = this.sessions.top(s).roles;
    if (!own?.start && !own?.escalate) return this.router;
    const roles = this.rolesOf(s);
    return this.newRouter({
      ...this.options.config.routing,
      start: roles.start,
      escalate: roles.escalate,
    });
  }

  /**
   * Why a remote model may not be called for this session now, or undefined
   * when it may: an organization's switch, `routing.allowRemote`, private
   * content, or a spent budget. Remote calls made outside the router (review,
   * summaries, the classifier, external runtimes) all check this.
   */
  private remoteBlocked(s?: LiveSession): string | undefined {
    const { org, config } = this.options;
    if (org?.remoteDisabled) return `remote models are disabled by ${org.name} policy`;
    if (!config.routing.allowRemote) return 'remote models are turned off (routing.allowRemote)';
    if (s?.private)
      return `this session holds private content (${s.private}), which never leaves this machine`;
    return budgetReached(config.routing.budget, this.ledger.spend());
  }

  /** Matcher for `privacy.localOnlyPaths`, rebuilt when the patterns change. */
  private privatePaths(): PrivatePathMatcher | undefined {
    const patterns = this.options.config.privacy.localOnlyPaths;
    const key = JSON.stringify(patterns);
    if (this.privateMatcher?.key !== key)
      this.privateMatcher = { key, matches: privatePathMatcher(patterns) };
    return this.privateMatcher.matches;
  }

  private summary(s: LiveSession): SessionSummary {
    return this.summaryOf(s.header, s.updatedAt);
  }

  private summaryOf(header: SessionHeader, updatedAt: string): SessionSummary {
    const cost = this.ledger.sessionCost(header.id);
    return {
      id: header.id,
      title: header.title,
      agent: header.agent,
      ...(header.parentId ? { parentId: header.parentId } : {}),
      createdAt: header.createdAt,
      updatedAt,
      usage: cost.usage,
      costUsd: cost.costUsd,
      savingsUsd: cost.savingsUsd,
      ...(this.sessions.get(header.id)?.controller ? { running: true } : {}),
      ...(header.parentId
        ? {}
        : {
            permissionMode:
              this.sessions.get(header.id)?.mode ?? this.options.config.permissions.defaultMode,
          }),
    };
  }

  /** Where a session's tools operate: its worktree, or the workspace. */
  private rootOf(s: LiveSession): string {
    return s.header.worktree?.root ?? this.options.workspaceRoot;
  }
}
