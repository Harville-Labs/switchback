/**
 * The engine's parts, built and connected: the composition root behind
 * `Engine`. Collaborators reach each other only through the closures here,
 * called after everything is built, and the engine through `EngineHost`.
 */
import type { EngineEvent } from '@switchback/protocol';
import { AgentCatalog } from './agent-catalog.ts';
import { AgentLoop } from './agent-loop.ts';
import { Checkpoints, MemoryCheckpointStore } from './checkpoints.ts';
import { Compactor } from './compactor.ts';
import { referenceModel } from './config.ts';
import type { EngineOptions } from './engine-options.ts';
import { ExternalRuntimes } from './external-runtime.ts';
import { HookRunner } from './hooks/runner.ts';
import { TurnHooks } from './hooks/turn-hooks.ts';
import { UsageLedger } from './ledger.ts';
import { Library } from './library.ts';
import type { EngineHost, LiveSession } from './live-session.ts';
import type { McpHub } from './mcp/hub.ts';
import { ModelDirectory } from './model-directory.ts';
import { projectPaths, switchbackPaths } from './paths.ts';
import { PermissionGate } from './permissions/gate.ts';
import { configRules } from './permissions/policy.ts';
import { ReviewRunner } from './review-runner.ts';
import { SessionControls } from './session-controls.ts';
import { newSessionId, SessionFactory } from './session-factory.ts';
import { SessionPolicy } from './session-policy.ts';
import { SessionRegistry } from './session-registry.ts';
import { MemorySessionStore } from './store.ts';
import { Subagents } from './subagents.ts';
import { ToolRunner } from './tool-runner.ts';
import { type CommandRunner, createCommandRunner, shellOf } from './tools/process.ts';
import { TurnRunner } from './turn-runner.ts';
import { UsageRecorder } from './usage-recorder.ts';

/** What the parts need from the engine itself. */
export interface EngineIo {
  emit(event: EngineEvent): void;
  notify(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** The MCP servers, which the engine restarts when their config changes. */
  mcp(): McpHub | undefined;
}

export const newTurnId = () => `turn_${crypto.randomUUID().slice(0, 8)}`;

export function assembleEngine(options: EngineOptions, io: EngineIo) {
  const { config } = options;
  const now = options.now ?? (() => new Date());
  const models: ModelDirectory = new ModelDirectory(
    config,
    options.providers,
    (e) => io.emit(e),
    now,
  );
  const ledger: UsageLedger = new UsageLedger(
    options.ledgerFile,
    options.prices ?? {},
    referenceModel(config),
    options.now,
  );
  const sessions: SessionRegistry = new SessionRegistry(
    options.store ?? new MemorySessionStore(),
    () => options.config,
    now,
  );
  const agents: AgentCatalog = new AgentCatalog(options.agents, options.agentDirs, (m) =>
    io.notify('warn', m),
  );
  const library: Library = new Library(options.library ?? { commands: [], skills: [] }, (m) =>
    io.notify('warn', m),
  );
  const settings = { config: () => options.config, org: () => options.org };
  const policy: SessionPolicy = new SessionPolicy({
    ...settings,
    models: models,
    ledger: ledger,
    sessions: sessions,
  });
  const factory: SessionFactory = new SessionFactory({
    ...settings,
    workspaceRoot: options.workspaceRoot,
    instructions: options.instructions,
    agents: agents,
    library: library,
    sessions: sessions,
    ledger: ledger,
    now: now,
  });
  const recorder = new UsageRecorder(ledger, (e) => io.emit(e), now);
  const host: EngineHost = {
    config: () => options.config,
    org: () => options.org,
    emit: (e) => io.emit(e),
    notify: (level, message) => io.notify(level, message),
    append: (s, m) => sessions.append(s, m),
    rolesOf: (s) => policy.rolesOf(s),
    remoteBlocked: (s) => policy.remoteBlocked(s),
    recordUsage: (s, tier, model, usage, meta) => recorder.record(s, tier, model, usage, meta),
    rootOf: (s) => rootOf(s),
    top: (s) => sessions.top(s),
    session: (id) => sessions.get(id),
    privatePaths: () => policy.privatePaths(),
  };
  const compactor: Compactor = new Compactor(host, models);
  const controls: SessionControls = new SessionControls(host, {
    sessions: sessions,
    checkpoints: new Checkpoints(options.checkpoints ?? new MemoryCheckpointStore()),
    gate: () => gate,
    commands: () => commands,
    summary: (s) => factory.summary(s),
    newSessionId,
    now: now,
  });
  const paths = switchbackPaths();
  const dataDir = options.dataDir ?? paths.dataDir;
  const project = projectPaths(options.workspaceRoot);
  const configFiles = {
    user: options.userConfigFile ?? paths.configFile,
    project: project.configFile,
    projectLocal: project.localConfigFile,
  };
  const hooks: HookRunner = new HookRunner({
    hooks: () => options.config.hooks,
    workspaceRoot: options.workspaceRoot,
    argv: (command) => shellOf(options.config.bash).argv(command),
    notify: (level, message) => io.notify(level, message),
  });
  const commands: CommandRunner = createCommandRunner({
    settings: () => options.config.bash,
    onChange: (shell) => io.emit({ type: 'shell.updated', sessionId: shell.sessionId, shell }),
    sandbox: options.sandbox,
    workspaceRoot: options.workspaceRoot,
    switchbackDirs: [paths.configDir, dataDir],
    dataDir,
    rules: () => gate.policy().list(),
    notice: (message) => io.notify('warn', message),
  });
  // Collaborators call each other only after construction, through these closures.
  const gate: PermissionGate = new PermissionGate(host, {
    interaction: () => options.interaction ?? 'prompt',
    rules: () => (options.rules ??= configRules(options.config)),
    mode: (s) => controls.modeOf(s),
    // exit_plan_mode's result tells the model about the change itself.
    setMode: (s, mode) => controls.changeMode(sessions.top(s), mode, true),
    saveTo: { project: configFiles.projectLocal, user: configFiles.user },
  });
  const tools: ToolRunner = new ToolRunner(host, gate, {
    commands: commands,
    hooks: hooks,
    hookPayload: (s) => hookPayload(s),
    runSubagent: (parent, agent, prompt, description, signal, opts) =>
      subagents.run(parent, agent, prompt, description, signal, opts),
    noteEdit: (s, path, writer) => {
      reviews.noteEdit(s, path, writer);
      controls.noteCheckpoint(s, path);
    },
    skills: () => library.skills(),
    configFiles,
  });
  const external: ExternalRuntimes = new ExternalRuntimes(host, {
    injected: options.runtimes,
    invocationBudget: (s) => subagents.invocationBudget(s),
    checkPermission: (s, tool, input, ctx, signal) => gate.check(s, tool, input, ctx, signal),
  });
  const subagents: Subagents = new Subagents(host, {
    agent: (name) => agents.get(name),
    createSession: (p) => factory.create(p),
    runTurn: (s, text, route, signal, opts) =>
      turns.run(s, text, route, newTurnId(), signal, [], opts),
    runExternal: (s, agent, prompt, signal) => external.run(s, agent, prompt, signal),
    sessionCost: (id) => ledger.sessionCost(id).costUsd,
    children: (id) => sessions.children(id),
    workspaceRoot: options.workspaceRoot,
    dataDir: options.dataDir,
  });
  const reviews: ReviewRunner = new ReviewRunner(host, models, (s, route, turnId, signal) =>
    agentLoop.run(s, route, turnId, signal),
  );
  const agentLoop: AgentLoop = new AgentLoop(host, {
    external,
    models: models,
    tools: tools,
    compactor: compactor,
    subagents: subagents,
    ledger: ledger,
    router: (s) => policy.routerFor(s),
    agent: (name) => agents.get(name),
    agents: () => agents.all(),
    mcp: () => io.mcp(),
    interaction: () => options.interaction ?? 'prompt',
    beforeStep: (s, turnId) => {
      subagents.drainInbox(s);
      return s.depth === 0 ? turns.deliverQueued(s, turnId) : Promise.resolve();
    },
  });
  const turns: TurnRunner = new TurnRunner(host, {
    loop: agentLoop,
    hooks: new TurnHooks(hooks, (s) => hookPayload(s)),
    reviews: reviews,
    mode: (s) => controls.modeOf(s),
    checkpoint: (s, turnId, prompt) => controls.beginCheckpoint(s, turnId, prompt),
    mcp: () => io.mcp(),
  });

  /** What every hook hears about the session. */
  function hookPayload(s: LiveSession): Record<string, unknown> {
    return { session_id: s.header.id, permission_mode: controls.modeOf(s) };
  }
  /** Where a session's tools operate: its worktree, or the workspace. */
  function rootOf(s: LiveSession): string {
    return s.header.worktree?.root ?? options.workspaceRoot;
  }

  return {
    now,
    models,
    ledger,
    sessions,
    agents,
    library,
    policy,
    factory,
    host,
    compactor,
    controls,
    hooks,
    commands,
    gate,
    tools,
    external,
    subagents,
    reviews,
    agentLoop,
    turns,
  };
}

export type EngineParts = ReturnType<typeof assembleEngine>;
