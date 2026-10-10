/**
 * The engine: owns sessions, routing, providers, tools, permissions, and
 * subagents. Clients (TUI, VS Code, headless) drive it only through the
 * protocol methods mirrored here and observe it only through `EngineEvent`s.
 *
 * The parts live in their own modules and borrow what they need through an
 * `EngineHost`: tool calls (`tool-runner.ts`), review (`review-runner.ts`),
 * compaction (`compactor.ts`), subagents (`subagents.ts`), external runtimes
 * (`external-runtime.ts`), models and providers (`model-directory.ts`), and
 * the agent loop itself (`agent-loop.ts`). Sessions are made by
 * `session-factory.ts`, routed and checked by `session-policy.ts`, and run as
 * agents from `agent-catalog.ts`; `workspace.ts` builds an engine from disk.
 */
import {
  type AgentSummary,
  type Attachment,
  type CheckpointInfo,
  type CustomCommandInfo,
  type EngineEvent,
  type InitializeResult,
  type McpListResult,
  type PermissionDecision,
  type PermissionMode,
  type PermissionsListResult,
  PROTOCOL_VERSION,
  type RoutePreference,
  type SessionEscalateResult,
  type SessionGetResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionRewindParams,
  type SessionRewindResult,
  type SessionRoles,
  type SessionSetRolesParams,
  type SessionSummary,
  type SetupAnswerParams,
  type SetupStartParams,
  type ShellInfo,
  type UsagePeriod,
  type UsageReport,
} from '@switchback/protocol';
import type { Price } from '@switchback/providers';
import { type AgentSpec, draftWithSummarizer } from './authoring.ts';
import { referenceModel, type SwitchbackConfig } from './config.ts';
import type { EngineOptions } from './engine-options.ts';
import { assembleEngine, type EngineParts } from './engine-parts.ts';
import { changeNote } from './instructions-live.ts';
import type { LedgerEntry } from './ledger.ts';
import { type LiveSession, scope, type TurnResult } from './live-session.ts';
import { McpHub, mcpList, promptCommands } from './mcp/hub.ts';
import type { OrgStatus } from './org/policy.ts';
import { switchbackPaths } from './paths.ts';
import type { SourcedRule } from './permissions/policy.ts';
import type { NewSession } from './session-factory.ts';
import { SetupRuns } from './setup-flow/protocol-prompter.ts';
import type { TurnOptions } from './turn-runner.ts';

export type { EngineOptions } from './engine-options.ts';

export const ENGINE_VERSION = '1.1.0';

export class Engine {
  private listeners = new Set<(event: EngineEvent) => void>();
  private mcp: McpHub | undefined;
  private readonly setupRuns: SetupRuns;
  /** The collaborators (engine-parts.ts). */
  private readonly p: EngineParts;

  constructor(private readonly options: EngineOptions) {
    this.mcp = this.startMcp(options.config);
    this.setupRuns = new SetupRuns(
      options.workspaceRoot,
      (e) => this.emit(e),
      options.setup,
      () => {
        try {
          if (options.reloadConfig) this.applyConfig(options.reloadConfig());
        } catch (err) {
          this.notify('error', `the new configuration wasn't applied: ${(err as Error).message}`);
        }
      },
    );
    this.p = assembleEngine(options, {
      emit: (e) => this.emit(e),
      notify: (level, message) => this.notify(level, message),
      mcp: () => this.mcp,
    });
    this.p.instructions.watch?.((scopes) =>
      this.emit({ type: 'config.updated', notes: scopes.map(changeNote) }),
    );
  }

  private startMcp(config: SwitchbackConfig): McpHub | undefined {
    if (!Object.keys(config.mcpServers).length) return undefined;
    return new McpHub(config.mcpServers, this.options.workspaceRoot, (level, message) =>
      this.notify(level, message),
    );
  }

  /** `mcp.list`. */
  mcpStatus(): Promise<McpListResult> {
    return mcpList(this.mcp, this.options.untrustedMcp);
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
    this.p.hooks.notifyFor(event);
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
      models: this.p.models.summaries(),
      agents: this.listAgents(),
      notifications: this.options.config.notifications,
      ...(org ? { org: { id: org.id, name: org.name, version: org.version } } : {}),
    };
  }

  listAgents(): AgentSummary[] {
    return this.p.agents.list();
  }

  /** `commands.list`. */
  async listCommands(): Promise<CustomCommandInfo[]> {
    // MCP prompts are commands too, named for their server (waiting briefly for servers still connecting).
    if (this.mcp) await Promise.race([this.mcp.ready, Bun.sleep(5_000)]);
    return [...this.p.library.listCommands(), ...promptCommands(this.mcp?.status() ?? [])];
  }

  createSession(params: NewSession): SessionSummary {
    return this.p.factory.summary(this.p.factory.create(params));
  }

  /** Top-level sessions in this workspace, most recently updated first. */
  listSessions(): SessionSummary[] {
    return this.p.factory.list();
  }

  getSession(sessionId: string): SessionGetResult {
    const s = this.p.sessions.live(sessionId);
    return { session: this.p.factory.summary(s), messages: s.messages };
  }

  /** A session's effective roles: its own changes over the config. */
  roles(sessionId: string): SessionRoles {
    return this.p.policy.rolesOf(this.p.sessions.live(sessionId));
  }

  /**
   * Change a session's roles (ADR 0015). With `save`, write them to the user
   * config as the default for new sessions. Keys an organization enforces
   * can't be changed.
   */
  setRoles(params: SessionSetRolesParams): SessionRoles & { savedTo?: string } {
    const s = this.p.sessions.top(this.p.sessions.live(params.sessionId));
    const file = this.options.userConfigFile ?? switchbackPaths().configFile;
    const result = this.p.policy.setRoles(s, params, file);
    const { savedTo: _, ...roles } = result;
    this.emit({ type: 'roles.updated', ...scope(s), roles });
    return result;
  }

  /** Start a turn and return immediately; progress arrives as events. */
  prompt(params: SessionPromptParams): SessionPromptResult {
    const { sessionId, text, ...rest } = params;
    // A custom command becomes its prompt here, so every client gets it the same way.
    return this.p.turns.start(this.p.sessions.live(sessionId), {
      ...rest,
      text: this.p.library.expand(text),
    });
  }

  /** `session.checkpoints`. */
  listCheckpoints(sessionId: string): CheckpointInfo[] {
    return this.p.controls.listCheckpoints(sessionId);
  }

  /** `session.rewind`. */
  rewind(params: SessionRewindParams): SessionRewindResult {
    return this.p.controls.rewind(params);
  }

  /** `session.dequeue`. */
  dequeue(sessionId: string, id: string): { removed: boolean } {
    return { removed: this.p.turns.dequeue(this.p.sessions.live(sessionId), id) };
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
    const session = typeof s === 'string' ? this.p.sessions.live(s) : s;
    return this.p.turns.run(session, text, route, turnId, parentSignal, extra, options);
  }

  /** Cancel the running turn and every background subagent the session started. */
  cancel(sessionId: string): boolean {
    const s = this.p.sessions.get(sessionId);
    return s ? this.p.turns.cancel(s) : false;
  }

  respondPermission(
    requestId: string,
    decision: PermissionDecision,
    save?: 'project' | 'user',
    feedback?: string,
  ): void {
    this.p.gate.prompts.answer(requestId, {
      decision,
      ...(save ? { save } : {}),
      ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
    });
  }

  /**
   * `session.escalate`: the user asked for a stronger model. The running
   * turn's next call climbs one step, or the next prompt starts one step up;
   * escalation's stickiness keeps the session there for a while after.
   */
  escalate(sessionId: string): SessionEscalateResult {
    const s = this.p.sessions.top(this.p.sessions.live(sessionId));
    s.escalateNow = true;
    return { when: s.controller ? 'next-step' : 'next-prompt' };
  }

  /** `session.setMode`. */
  setMode(sessionId: string, mode: PermissionMode): { mode: PermissionMode } {
    return this.p.controls.setMode(sessionId, mode);
  }

  /** `permissions.list`. */
  permissions(sessionId?: string): Promise<PermissionsListResult> {
    return this.p.controls.permissions(sessionId);
  }

  respondEscalation(requestId: string, approve: boolean): void {
    this.p.agentLoop.escalations.answer(requestId, approve);
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
    this.p.models.apply(next.config);
    this.p.gate.revokeGrants();
    this.options.rules = next.rules;
    if (JSON.stringify(next.config.mcpServers) !== JSON.stringify(this.options.config.mcpServers)) {
      void this.mcp?.close();
      this.mcp = this.startMcp(next.config);
    }
    this.options.config = next.config;
    if (next.org) this.options.org = next.org;
    if (next.untrustedMcp) this.options.untrustedMcp = next.untrustedMcp;
    this.p.policy.reconfigure(next.config);
    this.p.ledger.setPricing(next.prices ?? {}, referenceModel(next.config));
    const org = next.org;
    this.emit({
      type: 'config.updated',
      ...(org ? { org: { id: org.id, name: org.name, version: org.version } } : {}),
      notes: org?.notes ?? [],
    });
  }

  /** Ledger entries recorded after `sinceIso`, for usage reporting. */
  usageEntriesSince(sinceIso: string): LedgerEntry[] {
    return this.p.ledger.entriesSince(sinceIso);
  }

  usage(period?: UsagePeriod, sessionId?: string): UsageReport {
    return this.p.ledger.report(
      this.options.config.routing.budget,
      period,
      sessionId ? this.p.sessions.tree(sessionId) : undefined,
    );
  }

  /** `session.compact`: compact now, whatever the prompt size. */
  async compactSession(sessionId: string): Promise<{ compacted: boolean }> {
    const s = this.p.sessions.live(sessionId);
    const compacted = await this.p.compactor.compactNow(
      s,
      () => this.p.agentLoop.toolSetup(s).specsJson,
    );
    return { compacted };
  }

  /**
   * Draft a system prompt for a new agent (`switchback agents new`). A single
   * tool-free call on the same model choice as summaries: local when
   * reachable, remote only when routing and budget allow.
   */
  draftAgentPrompt(spec: AgentSpec): Promise<string> {
    return draftWithSummarizer(
      { models: this.p.models, compactor: this.p.compactor, ledger: this.p.ledger },
      spec,
    );
  }

  /** `shells.list`. */
  shells(sessionId?: string): ShellInfo[] {
    return this.p.commands.list(sessionId);
  }

  /** `shells.kill`. */
  killShell(shellId: string): ShellInfo {
    return this.p.commands.kill(shellId);
  }

  /** `setup.start`: setup's questions arrive as `setup.ask` events (setup-flow/). */
  startSetup(params: SetupStartParams): { setupId: string } {
    return this.setupRuns.start(params);
  }

  /** `setup.answer`. */
  answerSetup(params: SetupAnswerParams): void {
    this.setupRuns.answer(params);
  }

  /** `setup.cancel`. */
  cancelSetup(setupId: string): void {
    this.setupRuns.cancel(setupId);
  }

  async shutdown(): Promise<void> {
    this.p.instructions.close();
    await this.p.commands.close();
    for (const s of this.p.sessions.inMemory()) {
      s.controller?.abort();
      s.bgController?.abort();
    }
    await this.mcp?.close();
  }

  /** Whether any session has a turn in progress (daemons stay up while busy). */
  busy(): boolean {
    for (const s of this.p.sessions.inMemory()) if (s.controller || s.background.size) return true;
    return false;
  }
}
