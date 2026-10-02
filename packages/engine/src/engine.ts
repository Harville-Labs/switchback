/**
 * The engine: owns sessions, routing, providers, tools, permissions, and
 * subagents. Clients (TUI, VS Code, headless) drive it only through the
 * protocol methods mirrored here and observe it only through `EngineEvent`s.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  type AgentSummary,
  type Attachment,
  type EngineEvent,
  ErrorCode,
  type InitializeResult,
  type McpListResult,
  type Message,
  type ModelRef,
  type PermissionDecision,
  PROTOCOL_VERSION,
  type RoutePreference,
  RpcError,
  type SessionGetResult,
  type SessionRoles,
  type SessionSetRolesParams,
  type SessionSummary,
  type StopReason,
  type TextPart,
  type Tier,
  type ToolResultPart,
  textOf,
  type Usage,
  type UsagePeriod,
  type UsageReport,
} from '@switchback/protocol';
import {
  type ChatEvent,
  createProvider,
  type Price,
  type Provider,
  ProviderError,
  tierOf,
} from '@switchback/providers';
import { type Difficulty, type ModelInfo, Router, SignalTracker } from '@switchback/router';
import { z } from 'zod';
import { type AgentDefinition, loadAgents, summarize } from './agents.ts';
import { classifyPrompt } from './classifier.ts';
import {
  chooseBoundary,
  contextOf,
  latestMarker,
  renderForSummary,
  SUMMARIZER_PROMPT,
  summaryRequest,
} from './compaction.ts';
import { roleAliases, type SwitchbackConfig } from './config.ts';
import { estimateEscalationCost } from './estimate.ts';
import { type LedgerEntry, UsageLedger } from './ledger.ts';
import { allowsMcpTool, McpHub } from './mcp/hub.ts';
import { expandAttachments, expandMentions } from './mentions.ts';
import type { OrgStatus } from './org/policy.ts';
import { projectPaths, switchbackPaths } from './paths.ts';
import {
  type PrivatePathMatcher,
  privatePathMatcher,
  privateReason,
  privateToolUse,
  redactOutbound,
  redactSecrets,
} from './privacy.ts';
import {
  feedbackText,
  parseReview,
  REVIEWER_PROMPT,
  type ReviewAnswer,
  reviewRequest,
  turnDiff,
} from './review.ts';
import { ClaudeAgentSdkRuntime } from './runtimes/claude-agent-sdk.ts';
import type { AgentRuntime } from './runtimes/runtime.ts';
import { Semaphore } from './semaphore.ts';
import { writeConfigLayer } from './setup.ts';
import {
  FileSessionStore,
  MemorySessionStore,
  type SessionHeader,
  type SessionStore,
} from './store.ts';
import {
  countTokens,
  nearThreshold,
  PER_MESSAGE_OVERHEAD,
  promptText,
  promptTokens,
} from './tokens.ts';
import {
  resolveInWorkspace,
  type SubagentResult,
  type Tool,
  type ToolContext,
  ToolError,
  type ToolPreview,
  toolSpec,
  toolsFor,
  truncate,
} from './tools/index.ts';
import { currentShell } from './tools/shell.ts';
import { createWorktree, finishWorktree, type Worktree } from './worktree.ts';

export const ENGINE_VERSION = '0.6.0';

export interface EngineOptions {
  workspaceRoot: string;
  config: SwitchbackConfig;
  prices?: Record<string, Price>;
  /** Override provider construction (tests, embedding). Keyed by provider id. */
  providers?: Map<string, Provider>;
  store?: SessionStore;
  /** Where saving a session's roles writes; default: the user config. */
  userConfigFile?: string;
  ledgerFile?: string;
  agents?: Map<string, AgentDefinition>;
  /** External agent runtimes by name, overriding `runtimes` in config (tests, embedding). */
  runtimes?: Map<string, AgentRuntime>;
  /** Where agent files live; rescanned so new agents appear without a restart. */
  agentDirs?: { dir: string; source: AgentDefinition['source'] }[];
  /** Project instructions (AGENTS.md / CLAUDE.md contents). */
  instructions?: string;
  /**
   * How to resolve `ask` permissions and escalations when no client answers.
   * `prompt` emits events and waits (interactive clients); `approve` / `deny`
   * decide immediately (headless runs).
   */
  interaction?: 'prompt' | 'approve' | 'deny';
  /** Organization policy in effect, reported to clients. */
  org?: OrgStatus;
  /** Where engine-owned files live (worktrees). Defaults to the switchback data directory. */
  dataDir?: string;
  /** Project MCP servers held back until trusted (from `loadConfig`). */
  untrustedMcp?: { name: string; source: string }[];
  now?: () => Date;
}

interface LiveSession {
  header: SessionHeader;
  messages: Message[];
  updatedAt: string;
  signals: SignalTracker;
  depth: number;
  controller?: AbortController;
  /** Subagent invocations: remote spend allowed for this session and its descendants. */
  budget?: { agent: string; limitUsd: number };
  /** Why the last turn stopped with an error, reported to a parent agent. */
  lastError?: string;
  /** Background subagents still running, by child session ID. */
  background: Map<string, Promise<void>>;
  /** Their reports, waiting to be appended at the next safe point. */
  inbox: TextPart[];
  /** Cancels background subagents (they outlive the turn that started them). */
  bgController?: AbortController;
  /** The previous remote call, to check that the next one hits the prompt cache. */
  lastRemote?: { key: string; at: number };
  cacheWarned?: boolean;
  /**
   * Files edited during the current top-level turn (by this session or its
   * subagents in the same checkout), keyed by absolute path: content before
   * the first edit, and which models (aliases) edited it. For review.
   */
  turnEdits?: Map<string, { path: string; before: string | undefined; writers: Set<string> }>;
  /** Why the session holds private content and must stay local; never cleared. */
  private?: string;
  /** Roles this session changed (`session.setRoles`); its subagents follow them. */
  roles?: {
    start?: string[];
    escalate?: string[][];
    review?: { mode?: 'off' | 'auto'; models?: string[][] };
    subagents?: string | null;
  };
  /** Secrets redacted from the last remote request, to report only new ones. */
  redacted?: number;
}

/** Shortest cache lifetime among providers (Anthropic's default TTL). */
const CACHE_TTL_MS = 5 * 60_000;
/**
 * Below this, a miss can be normal (providers only cache prompts above a
 * model-specific minimum), so it isn't worth a warning.
 */
const CACHE_CHECK_MIN_TOKENS = 4_096;

interface TurnResult {
  stopReason: StopReason;
  text: string;
}

const HEALTH_TTL_OK_MS = 30_000;
/** Assumed when neither config nor server says; small on purpose so we escalate rather than truncate. */
const UNKNOWN_LOCAL_CONTEXT = 8_192;
const UNKNOWN_REMOTE_CONTEXT = 200_000;
const HEALTH_TTL_FAIL_MS = 5_000;

/** The model whose prices define "saved": the first remote model in role order. */
function referenceModel(config: SwitchbackConfig): string | undefined {
  const alias = roleAliases(config.routing).find((a) => {
    const m = config.models[a];
    const pc = m && config.providers[m.provider];
    return pc && tierOf(pc) === 'remote';
  });
  return alias ? config.models[alias]?.model : undefined;
}

export class Engine {
  private listeners = new Set<(event: EngineEvent) => void>();
  private sessions = new Map<string, LiveSession>();
  private providers = new Map<string, Provider>();
  private health = new Map<string, { ok: boolean; at: number }>();
  /** Context windows reported by servers; null means asked and got no answer. */
  private detectedContext = new Map<string, number | null>();
  private pendingPermissions = new Map<string, (d: PermissionDecision) => void>();
  private pendingEscalations = new Map<string, (approve: boolean) => void>();
  private alwaysAllowed = new Set<string>();
  private subagentSlots = new Map<number, Semaphore>();
  private router: Router;
  private readonly ledger: UsageLedger;
  /** Provider config each live provider was built from, to rebuild only what changed. */
  private providerConfigs = new Map<string, string>();
  private readonly store: SessionStore;
  private agents: Map<string, AgentDefinition>;
  private agentErrorsSeen = new Set<string>();
  private readonly now: () => Date;
  private mcp: McpHub | undefined;
  private privateMatcher: { key: string; matches: PrivatePathMatcher | undefined } | undefined;

  constructor(private readonly options: EngineOptions) {
    const { config } = options;
    for (const [id, pc] of Object.entries(config.providers)) {
      this.providers.set(id, options.providers?.get(id) ?? createProvider(id, pc));
      this.providerConfigs.set(id, JSON.stringify(pc));
    }
    for (const [id, p] of options.providers ?? []) this.providers.set(id, p);
    this.router = new Router(config.routing, (alias) => this.modelInfo(alias));
    const reference = referenceModel(config);
    this.ledger = new UsageLedger(options.ledgerFile, options.prices ?? {}, reference, options.now);
    this.store = options.store ?? new MemorySessionStore();
    this.agents = options.agents ?? loadAgents([]).agents;
    this.now = options.now ?? (() => new Date());
    this.mcp = this.startMcp(config);
  }

  private startMcp(config: SwitchbackConfig): McpHub | undefined {
    if (!Object.keys(config.mcpServers).length) return undefined;
    return new McpHub(config.mcpServers, this.options.workspaceRoot, (level, message) =>
      this.notify(level, message),
    );
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
      { dir: pp.claudeAgentsDir, source: 'claude-compat' },
      { dir: pp.agentsDir, source: 'project' },
    ];
    const { agents, errors } = loadAgents(agentDirs);
    const instructionFile = pp.instructionFiles.find((f) => existsSync(f));
    const instructions = instructionFile ? readFileSync(instructionFile, 'utf8') : undefined;
    const engine = new Engine({
      workspaceRoot,
      config,
      agents,
      agentDirs,
      ...(instructions ? { instructions } : {}),
      ledgerFile: hp.usageFile,
      store: new FileSessionStore(hp.sessionsDir),
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
  }

  private scope(s: LiveSession) {
    return {
      sessionId: s.header.id,
      ...(s.header.parentId ? { parentSessionId: s.header.parentId } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Protocol surface
  // -------------------------------------------------------------------------

  initialize(): InitializeResult {
    return {
      protocolVersion: PROTOCOL_VERSION,
      engineVersion: ENGINE_VERSION,
      workspaceRoot: this.options.workspaceRoot,
      models: Object.entries(this.options.config.models).map(([alias, m]) => ({
        alias,
        ref: { provider: m.provider, model: m.model },
        tier: this.tierOfProvider(m.provider),
      })),
      agents: this.listAgents(),
      ...(this.options.org
        ? {
            org: {
              id: this.options.org.id,
              name: this.options.org.name,
              version: this.options.org.version,
            },
          }
        : {}),
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
  }): SessionSummary {
    const agentName = params.agent ?? this.options.config.defaultAgent;
    if (!params.parentId) this.refreshAgents();
    const agent = this.agents.get(agentName);
    if (!agent) throw new RpcError(ErrorCode.InvalidParams, `unknown agent "${agentName}"`);
    const parent = params.parentId ? this.sessions.get(params.parentId) : undefined;
    const now = this.now().toISOString();
    const header: SessionHeader = {
      id: `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
      title: params.title ?? '',
      agent: agent.name,
      ...(params.parentId ? { parentId: params.parentId } : {}),
      workspaceRoot: this.options.workspaceRoot,
      ...(params.worktree
        ? {
            worktree: {
              path: params.worktree.path,
              root: params.worktree.root,
              branch: params.worktree.branch,
            },
          }
        : {}),
      createdAt: now,
      system: this.systemPrompt(agent, params.worktree?.root),
    };
    this.store.create(header);
    const live: LiveSession = {
      header,
      messages: [],
      updatedAt: now,
      signals: new SignalTracker(this.options.config.routing.escalation),
      depth: parent ? parent.depth + 1 : 0,
      background: new Map(),
      inbox: [],
    };
    this.sessions.set(header.id, live);
    return this.summary(live);
  }

  /** Top-level sessions in this workspace, most recently updated first. */
  listSessions(): SessionSummary[] {
    return this.store
      .list()
      .filter(
        ({ header }) => !header.parentId && header.workspaceRoot === this.options.workspaceRoot,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ header, updatedAt }) => this.summaryOf(header, updatedAt));
  }

  getSession(sessionId: string): SessionGetResult {
    const s = this.live(sessionId);
    return { session: this.summary(s), messages: s.messages };
  }

  /** A session's effective roles: its own changes over the config. */
  roles(sessionId: string): SessionRoles {
    return this.rolesOf(this.live(sessionId));
  }

  /**
   * Change a session's roles (ADR 0015). With `save`, write them to the user
   * config as the default for new sessions. Keys an organization enforces
   * can't be changed.
   */
  setRoles(params: SessionSetRolesParams): SessionRoles & { savedTo?: string } {
    const s = this.top(this.live(params.sessionId));
    const { models } = this.options.config;
    const named = [
      ...(params.start ?? []),
      ...(params.escalate?.flat() ?? []),
      ...(params.review?.models?.flat() ?? []),
      ...(params.subagents ? [params.subagents] : []),
    ];
    const unknown = named.find((a) => !models[a]);
    if (unknown)
      throw new RpcError(
        ErrorCode.InvalidParams,
        `"${unknown}" is not a configured model (${Object.keys(models).join(', ')})`,
      );
    const org = this.options.org;
    const locked = [
      ['start', 'routing.start'],
      ['escalate', 'routing.escalate'],
      ['review', 'review.'],
      ['subagents', 'subagents.model'],
    ].find(
      ([param, key]) =>
        params[param as keyof SessionSetRolesParams] !== undefined &&
        org?.enforcedKeys.some((k) => k.startsWith(key as string)),
    );
    if (locked && org)
      throw new RpcError(
        ErrorCode.InvalidParams,
        `${org.name}'s policy sets ${locked[1]?.replace(/\.$/, '')}; it can't be changed here`,
      );
    const roles = params.reset ? {} : { ...s.roles };
    if (params.start) roles.start = params.start;
    if (params.escalate) roles.escalate = params.escalate;
    if (params.review) roles.review = { ...roles.review, ...params.review };
    if (params.subagents !== undefined) roles.subagents = params.subagents;
    s.roles = roles;
    const result = this.rolesOf(s);
    let savedTo: string | undefined;
    if (params.save) {
      const file = this.options.userConfigFile ?? switchbackPaths().configFile;
      writeConfigLayer(
        file,
        {
          routing: { start: result.start, escalate: result.escalate },
          review: result.review,
          ...(result.subagents ? { subagents: { model: result.subagents } } : {}),
          // Checked above against the merged config; the models may live in another file.
        },
        { references: false },
      );
      savedTo = file;
    }
    this.emit({ type: 'roles.updated', ...this.scope(s), roles: result });
    return { ...result, ...(savedTo ? { savedTo } : {}) };
  }

  /** The top-level session of a subagent (or the session itself). */
  private top(s: LiveSession): LiveSession {
    let top = s;
    while (top.header.parentId) {
      const parent = this.sessions.get(top.header.parentId);
      if (!parent) break;
      top = parent;
    }
    return top;
  }

  private rolesOf(s: LiveSession): SessionRoles {
    const { routing, review, subagents } = this.options.config;
    const own = this.top(s).roles ?? {};
    const sub = own.subagents === null ? undefined : (own.subagents ?? subagents.model);
    return {
      start: own.start ?? routing.start,
      escalate: own.escalate ?? routing.escalate,
      review: {
        mode: own.review?.mode ?? review.mode,
        models: own.review?.models ?? review.models,
      },
      ...(sub ? { subagents: sub } : {}),
      overridden: (['start', 'escalate', 'review', 'subagents'] as const).filter(
        (k) => own[k] !== undefined,
      ),
    };
  }

  /** The router for a session: the config's, or one with the session's own roles. */
  private routerFor(s: LiveSession): Router {
    const own = this.top(s).roles;
    if (!own?.start && !own?.escalate) return this.router;
    const roles = this.rolesOf(s);
    return new Router(
      { ...this.options.config.routing, start: roles.start, escalate: roles.escalate },
      (alias) => this.modelInfo(alias),
    );
  }

  /** Start a turn and return immediately; progress arrives as events. */
  prompt(params: {
    sessionId: string;
    text: string;
    route?: RoutePreference;
    attachments?: Attachment[];
    review?: boolean;
  }): { turnId: string } {
    const s = this.live(params.sessionId);
    if (s.controller)
      throw new RpcError(ErrorCode.SessionBusy, 'session is already running a turn');
    const turnId = `turn_${crypto.randomUUID().slice(0, 8)}`;
    void this.runTurn(
      s,
      params.text,
      params.route ?? 'auto',
      turnId,
      undefined,
      params.attachments ?? [],
      // Interactive sessions stay usable while background tasks run; their
      // reports start a follow-up turn when they arrive.
      {
        waitForBackground: false,
        ...(params.review !== undefined ? { review: params.review } : {}),
      },
    ).catch((err) => {
      this.emit({ type: 'error', ...this.scope(s), turnId, message: (err as Error).message });
    });
    return { turnId };
  }

  /** Run a full user turn to completion. Used directly by headless mode and subagents. */
  async runTurn(
    s: LiveSession | string,
    text: string,
    route: RoutePreference = 'auto',
    turnId = `turn_${crypto.randomUUID().slice(0, 8)}`,
    parentSignal?: AbortSignal,
    extra: Attachment[] = [],
    options: { waitForBackground?: boolean; private?: string; review?: boolean } = {},
  ): Promise<TurnResult> {
    const session = typeof s === 'string' ? this.live(s) : s;
    if (session.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is busy');
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    session.controller = controller;
    if (!session.header.title && text) session.header.title = text.slice(0, 60);

    this.emit({ type: 'turn.started', ...this.scope(session), turnId });
    // An empty prompt continues the session with whatever reports are waiting.
    if (text) {
      const matches = this.privatePaths();
      const attachments = [
        ...(await expandAttachments(extra, this.rootOf(session)).catch(() => [])),
        ...(await expandMentions(text, this.rootOf(session)).catch(() => [])),
      ].map((p) => {
        // A file attachment's path may carry a line range (`src/a.ts:3-9`).
        const path = p.attachment?.path.replace(/:\d+-\d+$/, '');
        return path && matches?.(path) ? { ...p, private: `attached ${path}` } : p;
      });
      this.append(session, {
        role: 'user',
        parts: [
          { type: 'text', text, ...(options.private ? { private: options.private } : {}) },
          ...attachments,
        ],
      });
    }
    session.signals.startUserTurn();
    if (session.depth === 0) session.turnEdits = new Map();

    let stopReason: StopReason = 'end_turn';
    try {
      stopReason = await this.loop(session, route, turnId, controller.signal);
      // Headless runs and subagents finish their background work before they
      // report, so nothing is left running unattended.
      while (
        options.waitForBackground !== false &&
        stopReason === 'end_turn' &&
        (session.background.size || session.inbox.length) &&
        !controller.signal.aborted
      ) {
        if (!session.inbox.length) await Promise.race(session.background.values());
        if (session.inbox.length)
          stopReason = await this.loop(session, route, turnId, controller.signal);
      }
      const review = options.review ?? this.rolesOf(session).review.mode === 'auto';
      if (review && session.depth === 0 && stopReason === 'end_turn' && text)
        stopReason = await this.reviewTurn(session, text, route, turnId, controller.signal);
    } catch (err) {
      stopReason = controller.signal.aborted ? 'cancelled' : 'error';
      if (stopReason === 'error')
        this.emit({
          type: 'error',
          ...this.scope(session),
          turnId,
          message: (err as Error).message,
        });
    } finally {
      session.controller = undefined;
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
    this.emit({ type: 'turn.completed', ...this.scope(session), turnId, stopReason });
    const last = session.messages.findLast((m) => m.role === 'assistant');
    return { stopReason, text: last ? textOf(last) : '' };
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
    return hadWork;
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const resolve = this.pendingPermissions.get(requestId);
    if (!resolve) throw new RpcError(ErrorCode.InvalidParams, `no pending permission ${requestId}`);
    this.pendingPermissions.delete(requestId);
    resolve(decision);
  }

  respondEscalation(requestId: string, approve: boolean): void {
    const resolve = this.pendingEscalations.get(requestId);
    if (!resolve) throw new RpcError(ErrorCode.InvalidParams, `no pending escalation ${requestId}`);
    this.pendingEscalations.delete(requestId);
    resolve(approve);
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
  }): void {
    const injected = this.options.providers;
    for (const id of [...this.providers.keys()]) {
      if (!next.config.providers[id] && !injected?.has(id)) {
        this.providers.delete(id);
        this.providerConfigs.delete(id);
        this.health.delete(id);
      }
    }
    for (const [id, pc] of Object.entries(next.config.providers)) {
      const json = JSON.stringify(pc);
      if (injected?.has(id) || this.providerConfigs.get(id) === json) continue;
      this.providers.set(id, createProvider(id, pc));
      this.providerConfigs.set(id, json);
      this.health.delete(id);
    }
    this.detectedContext.clear();
    this.alwaysAllowed.clear(); // grants were made under the old policy
    if (JSON.stringify(next.config.mcpServers) !== JSON.stringify(this.options.config.mcpServers)) {
      void this.mcp?.close();
      this.mcp = this.startMcp(next.config);
    }
    this.options.config = next.config;
    if (next.org) this.options.org = next.org;
    if (next.untrustedMcp) this.options.untrustedMcp = next.untrustedMcp;
    this.router = new Router(next.config.routing, (alias) => this.modelInfo(alias));
    this.ledger.setPricing(next.prices ?? {}, referenceModel(next.config));
    this.emit({
      type: 'config.updated',
      ...(next.org
        ? { org: { id: next.org.id, name: next.org.name, version: next.org.version } }
        : {}),
      notes: next.org?.notes ?? [],
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
      sessionId ? this.sessionTree(sessionId) : undefined,
    );
  }

  /** A session and every subagent session under it, live or stored. */
  private sessionTree(sessionId: string): Set<string> {
    const children = new Map<string, string[]>();
    const link = (id: string, parent: string | undefined) => {
      if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);
    };
    for (const { header } of this.store.list()) link(header.id, header.parentId);
    for (const s of this.sessions.values()) link(s.header.id, s.header.parentId);
    const tree = new Set<string>();
    const walk = (id: string) => {
      if (tree.has(id)) return;
      tree.add(id);
      for (const c of children.get(id) ?? []) walk(c);
    };
    walk(sessionId);
    return tree;
  }

  async shutdown(): Promise<void> {
    for (const s of this.sessions.values()) {
      s.controller?.abort();
      s.bgController?.abort();
    }
    await this.mcp?.close();
  }

  // -------------------------------------------------------------------------
  // The agent loop
  // -------------------------------------------------------------------------

  private async loop(
    s: LiveSession,
    preference: RoutePreference,
    turnId: string,
    signal: AbortSignal,
  ): Promise<StopReason> {
    // The first turn waits for MCP servers, so the tool list is complete and stable.
    if (this.mcp) await Promise.race([this.mcp.ready, Bun.sleep(20_000)]);
    const { agent, tools, catalog, specs, specsJson } = this.toolSetup(s);
    let escalationApproved = false;
    let forceLocal = false;
    /** Remote aliases that refused this turn, and whether the next call retries one. */
    const refused: string[] = [];
    let refusalRetry = false;
    /** Used by the first routing decision of the turn only. */
    let difficulty = await this.classifyTurn(s, preference, agent, signal);
    let failures = 0;

    for (let step = 0; step < this.options.config.maxStepsPerTurn; step++) {
      if (signal.aborted) return 'cancelled';
      await this.refreshHealth(signal);
      this.drainInbox(s);
      if (this.options.config.compaction.enabled) {
        // A failed summary costs context, not the turn: routing still has
        // overflow escalation to fall back on.
        await this.compact(s, specsJson, signal, false, turnId).catch((err) => {
          if (!signal.aborted) this.notify('warn', `compaction failed: ${(err as Error).message}`);
        });
      }

      const inputTokens = await this.countPrompt(s, specsJson, signal);
      const router = this.routerFor(s);
      const signals = s.signals.snapshot();
      const decision = router.decide({
        preference,
        escalationDeclined: forceLocal,
        refused,
        refusalRetry,
        ...(difficulty ? { difficulty } : {}),
        ...(await this.privacyOf(s)),
        ...this.invocationBudget(s),
        agent: {
          name: agent.name,
          route: agent.route,
          ...this.pinnedModel(s, agent),
        },
        estimatedInputTokens: inputTokens,
        signals,
        spend: this.ledger.spend(),
        escalationApproved,
      });

      if (
        decision.kind === 'block' &&
        this.options.org?.remoteDisabled &&
        preference === 'remote'
      ) {
        this.emit({
          type: 'error',
          ...this.scope(s),
          turnId,
          message: `remote models are disabled by ${this.options.org.name} policy`,
        });
        return 'error';
      }
      if (decision.kind === 'block') {
        s.lastError = `cannot route turn: ${decision.reason}`;
        this.emit({ type: 'error', ...this.scope(s), turnId, message: s.lastError });
        return 'error';
      }
      if (decision.kind === 'ask') {
        const estimate = estimateEscalationCost({
          price: this.ledger.priceOf(decision.target.ref.model),
          inputTokens,
          outputTokens: this.ledger.meanOutputTokens(s.header.id),
          calls: 1 + this.options.config.routing.escalation.stickyTurns,
        });
        const approved = await this.askEscalation(
          s,
          decision.target.ref,
          decision.reason,
          estimate,
          signal,
        );
        escalationApproved = approved;
        forceLocal = !approved;
        step--;
        continue;
      }

      refusalRetry = false;
      difficulty = undefined;
      const { model, rule, reason, escalated } = decision;
      this.emit({
        type: 'route.decided',
        ...this.scope(s),
        turnId,
        tier: model.tier,
        model: model.ref,
        rule,
        reason,
        inputTokens,
        step: decision.step,
        steps: this.rolesOf(s).escalate.length,
        ...(decision.step > 0 && !escalated ? { stickyTurns: signals.stickyTurns } : {}),
        ...(escalated ? { stickyTurns: this.options.config.routing.escalation.stickyTurns } : {}),
      });
      const provider = this.providers.get(model.ref.provider);
      if (!provider) throw new Error(`provider "${model.ref.provider}" is not configured`);
      const modelConfig = this.options.config.models[model.alias];

      // A fresh array (so providers never observe later appends), built from
      // the latest compaction marker; for remote models, with secrets redacted.
      const outbound = await this.outbound(s, model, s.header.system, contextOf(s.messages));
      let done: Extract<ChatEvent, { type: 'done' }> | undefined;
      try {
        for await (const ev of provider.stream({
          model: model.ref.model,
          system: outbound.system,
          messages: outbound.messages,
          tools: specs,
          maxTokens: modelConfig?.maxOutputTokens ?? 16_000,
          ...(modelConfig?.effort ? { effort: modelConfig.effort } : {}),
          signal,
        })) {
          if (ev.type === 'text.delta')
            this.emit({ type: 'text.delta', ...this.scope(s), turnId, text: ev.text });
          else if (ev.type === 'reasoning.delta')
            this.emit({ type: 'reasoning.delta', ...this.scope(s), turnId, text: ev.text });
          else done = ev;
        }
      } catch (err) {
        if (signal.aborted) return 'cancelled';
        const retryable = err instanceof ProviderError && err.retryable;
        if (retryable) this.health.set(provider.id, { ok: false, at: this.now().getTime() });
        s.signals.recordFailure();
        this.emit({
          type: 'log',
          level: 'warn',
          message: `${model.alias} failed: ${(err as Error).message}`,
        });
        if (++failures > 2) throw err;
        continue; // re-route: the router sees the failure and escalates or falls back
      }
      if (!done) throw new Error(`${provider.id} ended the stream without a result`);

      // A provider-side fallback may have answered with a different model; bill that one.
      const servedBy = done.model && done.model !== model.ref.model ? done.model : undefined;
      if (servedBy)
        this.emit({
          type: 'log',
          level: 'info',
          message: `${model.ref.model} declined; ${model.ref.provider} answered with ${servedBy}`,
        });
      this.recordUsage(
        s,
        model.tier,
        servedBy ? { ...model.ref, model: servedBy } : model.ref,
        done.usage,
        { rule, agent: agent.name },
      );
      s.signals.recordTurn(decision.step, escalated);
      escalationApproved = false;

      const toolCalls = done.parts.filter((p) => p.type === 'tool_call');
      const truncatedTools = done.stopReason === 'max_tokens' && toolCalls.length > 0;

      // A remote refusal is retried on another model of the same step or above,
      // if there is one. The refused output is discarded, not added to the transcript.
      if (model.tier === 'remote' && done.stopReason === 'refusal') {
        const { routing, models } = this.options.config;
        const steps = [routing.start, ...routing.escalate];
        const at = Math.max(
          0,
          steps.findIndex((c) => c.includes(model.alias)),
        );
        const others = steps
          .slice(at)
          .flat()
          .filter((a) => a !== model.alias && !refused.includes(a) && models[a]);
        if (others.length) {
          refused.push(model.alias);
          refusalRetry = true;
          continue;
        }
      }

      // A model that refuses (a local one) or runs out of room mid-tool-call gets
      // another chance one step up instead of ending the user's turn.
      if ((model.tier === 'local' && done.stopReason === 'refusal') || truncatedTools) {
        s.signals.recordFailure();
        if (++failures <= 2) continue;
      }

      const meta = { model: model.ref, tier: model.tier, routeReason: reason };
      if (truncatedTools) {
        // Never run tools whose input was cut off.
        this.append(s, {
          role: 'assistant',
          parts: done.parts.filter((p) => p.type !== 'tool_call'),
          meta,
        });
        return 'max_tokens';
      }
      this.append(s, { role: 'assistant', parts: done.parts, meta });
      if (toolCalls.length === 0)
        return done.stopReason === 'tool_use' ? 'end_turn' : done.stopReason;

      const results = await this.runTools(
        s,
        tools,
        catalog,
        toolCalls,
        turnId,
        signal,
        model.tier,
        model.alias,
      );
      this.append(s, { role: 'user', parts: results });
      if (signal.aborted) return 'cancelled';
    }
    this.emit({
      type: 'error',
      ...this.scope(s),
      turnId,
      message: `stopped after ${this.options.config.maxStepsPerTurn} steps`,
    });
    return 'max_tokens';
  }

  /**
   * Rate the new prompt with the configured local classifier, when its answer
   * could change anything: automatic routing, no pins, not already sticky, and
   * a remote model to escalate to. Never runs on a remote model (that would
   * spend money on every prompt).
   */
  private async classifyTurn(
    s: LiveSession,
    preference: RoutePreference,
    agent: AgentDefinition,
    signal: AbortSignal,
  ): Promise<Difficulty | undefined> {
    const routing = this.options.config.routing;
    const c = routing.classifier;
    if (!c || preference !== 'auto') return undefined;
    if (agent.model || agent.route !== 'auto' || s.signals.snapshot().stickyTurns > 0)
      return undefined;
    // Nothing to escalate to.
    if (
      !this.rolesOf(s)
        .escalate.flat()
        .some((a) => this.options.config.models[a])
    )
      return undefined;
    const model = this.modelInfo(c.model);
    if (!model) {
      this.notify('warn', `routing.classifier.model "${c.model}" is not a configured model`);
      return undefined;
    }
    // A remote classifier reads the prompt, so the remote rules apply to it.
    if (model.tier === 'remote' && (s.private || !routing.allowRemote)) return undefined;
    if (!model.available) return undefined;
    const provider = this.providers.get(model.ref.provider);
    const prompt = s.messages.findLast(
      (m) => m.role === 'user' && m.parts.some((p) => p.type === 'text' && !p.attachment),
    );
    if (!provider || !prompt) return undefined;
    const text = prompt.parts
      .flatMap((p) => (p.type === 'text' && !p.attachment ? [p.text] : []))
      .join('\n');
    const r = await classifyPrompt(provider, model.ref.model, text, {
      signal,
      timeoutMs: c.timeoutMs,
    });
    if (r.usage)
      this.recordUsage(s, model.tier, model.ref, r.usage, { rule: 'classify', agent: agent.name });
    this.notify(
      'debug',
      r.difficulty
        ? `classifier: ${r.difficulty.level} in ${Math.round(r.ms)}ms (${r.difficulty.reason})`
        : `classifier: no rating in ${Math.round(r.ms)}ms`,
    );
    return r.difficulty;
  }

  /** The agent's tools and their specs for a session; fixed order keeps the cache prefix stable. */
  private toolSetup(s: LiveSession) {
    const agent = this.agents.get(s.header.agent);
    if (!agent) throw new Error(`agent "${s.header.agent}" no longer exists`);
    const canDelegate = s.depth < this.options.config.subagents.maxDepth;
    const mcpTools = (this.mcp?.tools() ?? []).filter(
      (t) => !agent.tools || allowsMcpTool(agent.tools, t.name),
    );
    // Built-ins first in their fixed order, then MCP tools by name: a stable cache prefix.
    const tools = [...toolsFor(agent.tools), ...mcpTools].filter(
      (t) => t.name !== 'task' || canDelegate,
    );
    const catalog = [...this.agents.values()]
      .filter((a) => a.name !== s.header.agent || s.depth === 0)
      .map((a) => ({ name: a.name, description: a.description }));
    const specs = tools.map((t) => toolSpec(t, { agentCatalog: catalog }));
    return { agent, tools, catalog, specs, specsJson: JSON.stringify(specs) };
  }

  // -------------------------------------------------------------------------
  // Draft locally, review with a stronger model (docs/review.md)
  // -------------------------------------------------------------------------

  /** Remember a file's content before its first edit this turn, on the top-level session. */
  private noteEdit(s: LiveSession, path: string, writer: string): void {
    let top = s;
    while (top.header.parentId) {
      const parent = this.sessions.get(top.header.parentId);
      if (!parent) break;
      top = parent;
    }
    // An isolated subagent's edits are on its own branch, reported with their own diff.
    if (!top.turnEdits || this.rootOf(s) !== this.rootOf(top)) return;
    let file: string;
    try {
      file = resolveInWorkspace(this.rootOf(s), path);
    } catch {
      return; // the tool will report the bad path
    }
    const entry = top.turnEdits.get(file) ?? {
      path: relative(this.rootOf(top), file).split(sep).join('/'),
      before: existsSync(file) ? readFileSync(file, 'utf8') : undefined,
      writers: new Set<string>(),
    };
    entry.writers.add(writer);
    top.turnEdits.set(file, entry);
  }

  /**
   * Review what models changed this turn; on `revise`, hand the findings back
   * and let the model fix them, up to `review.maxRounds` reviews. Reviewers
   * form a ladder: when a reviewer's findings still stand after a fix, the
   * next reviewer takes over.
   */
  private async reviewTurn(
    s: LiveSession,
    request: string,
    route: RoutePreference,
    turnId: string,
    signal: AbortSignal,
  ): Promise<StopReason> {
    const rounds = this.options.config.review.maxRounds;
    const ladder = this.reviewLadder(s);
    let stopReason: StopReason = 'end_turn';
    let at = 0;
    let revisedBy = -1;
    for (let round = 1; round <= rounds && !signal.aborted; round++) {
      const edits = [...(s.turnEdits?.entries() ?? [])];
      if (!edits.length) return stopReason;
      const writers = new Set(edits.flatMap(([, e]) => [...e.writers]));
      const diff = turnDiff(
        edits.map(([file, e]) => ({
          path: e.path,
          before: e.before,
          after: existsSync(file) ? readFileSync(file, 'utf8') : undefined,
        })),
      );
      if (!diff) return stopReason;
      const pick = this.pickReviewer(s, ladder, at, writers);
      if ('skip' in pick) {
        this.emit({
          type: 'review.completed',
          ...this.scope(s),
          turnId,
          verdict: 'skipped',
          summary: pick.skip,
          issues: [],
          round,
        });
        return stopReason;
      }
      at = pick.step;
      const result = await this.review(
        s,
        pick.model,
        request,
        diff,
        edits.length,
        round,
        turnId,
        signal,
      );
      if (result?.answer.verdict !== 'revise' || round === rounds) return stopReason;
      // This reviewer already asked for changes once and still does: the next one takes over.
      const escalate = revisedBy === at && at + 1 < ladder.length;
      revisedBy = at;
      if (escalate) at += 1;
      this.append(s, {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: feedbackText(result.answer, result.model.ref.model),
            review: { round, model: result.model.ref },
          },
        ],
      });
      stopReason = await this.loop(s, route, turnId, signal);
      if (stopReason !== 'end_turn') return stopReason;
    }
    return stopReason;
  }

  /** Reviewers in order: `review.models`, else the escalation ladder (the session's own, if changed). */
  private reviewLadder(s: LiveSession): string[][] {
    const roles = this.rolesOf(s);
    return roles.review.models.length ? roles.review.models : roles.escalate;
  }

  /**
   * The first reviewer from step `from` up that's configured, up, allowed,
   * and didn't write the change; else why none could review.
   */
  private pickReviewer(
    s: LiveSession,
    ladder: string[][],
    from: number,
    writers: Set<string>,
  ): { model: ModelInfo; step: number } | { skip: string } {
    if (!ladder.length)
      return { skip: 'no reviewer is configured (review.models, or a routing.escalate step)' };
    const { routing } = this.options.config;
    const writerRefs = new Set(
      [...writers].flatMap((a) => {
        const m = this.modelInfo(a);
        return m ? [`${m.ref.provider}/${m.ref.model}`] : [];
      }),
    );
    let why: string | undefined;
    for (let step = from; step < ladder.length; step++) {
      for (const alias of ladder[step] ?? []) {
        const model = this.modelInfo(alias);
        if (!model) continue;
        // A model never reviews its own work.
        if (writers.has(alias) || writerRefs.has(`${model.ref.provider}/${model.ref.model}`)) {
          why ??= `${alias} wrote the change, and a model never reviews its own work`;
          continue;
        }
        if (!model.available) {
          why ??= `${alias} is unavailable`;
          continue;
        }
        if (model.tier === 'remote') {
          // Remote review is remote spend: every rule that keeps other calls local applies.
          const spend = this.ledger.spend();
          const b = routing.budget;
          const blocked = this.options.org?.remoteDisabled
            ? `remote models are disabled by ${this.options.org.name} policy`
            : !routing.allowRemote
              ? 'remote models are turned off (routing.allowRemote)'
              : s.private
                ? `this session holds private content (${s.private}), which never leaves this machine`
                : (b.dailyUsd !== undefined && spend.todayUsd >= b.dailyUsd) ||
                    (b.monthlyUsd !== undefined && spend.monthUsd >= b.monthlyUsd)
                  ? 'the remote budget is spent'
                  : undefined;
          if (blocked) {
            why ??= blocked;
            continue;
          }
        }
        return { model, step };
      }
    }
    return { skip: why ?? 'no reviewer is available' };
  }

  /** The agent's own model pin; for a subagent without one, the subagent model. */
  private pinnedModel(s: LiveSession, agent: AgentDefinition): { model?: string } {
    if (agent.model) return { model: agent.model };
    const fallback = this.rolesOf(s).subagents;
    return s.depth > 0 && agent.route === 'auto' && fallback ? { model: fallback } : {};
  }

  /** One review call. Never fails the turn: problems are reported as `skipped`. */
  private async review(
    s: LiveSession,
    model: ModelInfo,
    request: string,
    diff: string,
    files: number,
    round: number,
    turnId: string,
    signal: AbortSignal,
  ): Promise<{ answer: ReviewAnswer; model: ModelInfo } | undefined> {
    const skip = (summary: string) => {
      this.emit({
        type: 'review.completed',
        ...this.scope(s),
        turnId,
        verdict: 'skipped',
        summary,
        issues: [],
        round,
        model: model.ref,
      });
      return undefined;
    };
    const { privacy } = this.options.config;
    const provider = this.providers.get(model.ref.provider);
    if (!provider) return skip(`provider "${model.ref.provider}" is not configured`);
    const summary = textOf(
      s.messages.findLast((m) => m.role === 'assistant') ?? { role: 'assistant', parts: [] },
    );
    let text = reviewRequest(request, summary, diff);
    // Remote rules (privacy, budget, remote off) were checked when picking the reviewer.
    if (model.tier === 'remote') {
      if (privacy.secrets !== 'off') {
        const scan = await redactSecrets(text);
        if (scan.found.length && privacy.secrets === 'block')
          return skip(`the changes contain a secret (${scan.found[0]})`);
        if (scan.found.length)
          this.emit({
            type: 'secrets.redacted',
            ...this.scope(s),
            kinds: scan.found,
            model: model.ref,
          });
        text = scan.text;
      }
    }
    this.emit({
      type: 'route.decided',
      ...this.scope(s),
      turnId,
      tier: model.tier,
      model: model.ref,
      rule: 'review',
      reason: `reviewing ${files} changed file${files === 1 ? '' : 's'}${round > 1 ? ' (after revisions)' : ''}`,
    });
    const modelConfig = this.options.config.models[model.alias];
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    try {
      for await (const ev of provider.stream({
        model: model.ref.model,
        system: REVIEWER_PROMPT,
        messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
        tools: [],
        maxTokens: 4_000,
        ...(modelConfig?.effort ? { effort: modelConfig.effort } : {}),
        signal,
      })) {
        if (ev.type === 'done') done = ev;
      }
    } catch (err) {
      if (signal.aborted) return undefined;
      return skip(`${model.alias} failed: ${(err as Error).message}`);
    }
    if (!done) return skip(`${model.alias} returned no review`);
    this.recordUsage(s, model.tier, model.ref, done.usage, {
      rule: 'review',
      agent: s.header.agent,
    });
    const answer = parseReview(
      done.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''),
    );
    if (!answer) return skip(`${model.alias}'s review couldn't be read`);
    this.emit({
      type: 'review.completed',
      ...this.scope(s),
      turnId,
      verdict: answer.verdict,
      summary: answer.summary,
      issues: answer.issues,
      model: model.ref,
      round,
    });
    return { answer, model };
  }

  // -------------------------------------------------------------------------
  // Compaction (ADR 0008)
  // -------------------------------------------------------------------------

  /**
   * Draft a system prompt for a new agent (`switchback agents new`). A single
   * tool-free call on the same model choice as summaries: local when
   * reachable, remote only when routing and budget allow.
   */
  async draftAgentPrompt(spec: {
    name: string;
    purpose: string;
    description: string;
    tools?: string[];
  }): Promise<string> {
    const controller = new AbortController();
    await this.refreshHealth(controller.signal);
    const model = this.summarizerModel(0);
    const provider = model && this.providers.get(model.ref.provider);
    if (!model || !provider) throw new Error('no model is available to draft the prompt');
    const request = [
      `Write the system prompt for a coding subagent named "${spec.name}".`,
      `Purpose: ${spec.purpose}`,
      `The parent agent delegates to it when: ${spec.description}`,
      `Tools it can use: ${spec.tools?.join(', ') ?? 'all tools (read, glob, grep, edit, write, bash, task, and MCP tools)'}`,
      'It starts with no conversation history and must return one final report to the parent.',
      'Write in the second person ("You are..."). Cover how to approach the work, what to check, what not to do, and exactly what the final report should contain. Plain text, no preamble, under 250 words.',
    ].join('\n');
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    for await (const ev of provider.stream({
      model: model.ref.model,
      system: 'You write concise, specific system prompts for software engineering agents.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: request }] }],
      tools: [],
      maxTokens: 2_000,
      signal: controller.signal,
    })) {
      if (ev.type === 'done') done = ev;
    }
    if (!done) throw new Error('the model returned no draft');
    this.ledger.record('authoring', model.tier, model.ref, done.usage, {
      rule: 'authoring',
      agent: spec.name,
    });
    const text = done.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('')
      .trim();
    if (!text) throw new Error('the model returned an empty draft');
    return text;
  }

  /** Remote spend of a session and all its descendant sessions. */
  private treeCost(sessionId: string): number {
    let total = this.ledger.sessionCost(sessionId).costUsd;
    for (const live of this.sessions.values())
      if (live.header.parentId === sessionId) total += this.treeCost(live.header.id);
    return total;
  }

  /**
   * The tightest budget among this session and its ancestors: a nested
   * subagent also counts against every budgeted invocation above it.
   */
  private invocationBudget(s: LiveSession): {
    invocationBudget?: { agent: string; limitUsd: number; spentUsd: number };
  } {
    let tightest: { agent: string; limitUsd: number; spentUsd: number } | undefined;
    for (let cur: LiveSession | undefined = s; cur; ) {
      if (cur.budget) {
        const spentUsd = this.treeCost(cur.header.id);
        if (!tightest || cur.budget.limitUsd - spentUsd < tightest.limitUsd - tightest.spentUsd)
          tightest = { ...cur.budget, spentUsd };
      }
      cur = cur.header.parentId ? this.sessions.get(cur.header.parentId) : undefined;
    }
    return tightest ? { invocationBudget: tightest } : {};
  }

  /** `session.compact`: compact now, whatever the prompt size. */
  async compactSession(sessionId: string): Promise<{ compacted: boolean }> {
    const s = this.live(sessionId);
    if (s.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is running a turn');
    const controller = new AbortController();
    s.controller = controller;
    try {
      await this.refreshHealth(controller.signal);
      return {
        compacted: await this.compact(s, this.toolSetup(s).specsJson, controller.signal, true),
      };
    } finally {
      s.controller = undefined;
    }
  }

  /**
   * The window compaction keeps a session inside: the largest in the start
   * chain, so turns can always go back to it; else the first escalation step's.
   */
  private compactionWindow(): number | undefined {
    const routing = this.options.config.routing;
    const start = routing.start.flatMap((a) => this.modelInfo(a) ?? []);
    if (start.length) return Math.max(...start.map((m) => m.contextWindow));
    const first = (routing.escalate[0] ?? []).flatMap((a) => this.modelInfo(a) ?? [])[0];
    return first?.contextWindow;
  }

  /**
   * Summarize older history into an appended marker when the prompt passes the
   * threshold (or always, when forced). Returns whether a marker was written.
   */
  private async compact(
    s: LiveSession,
    specsJson: string,
    signal: AbortSignal,
    force: boolean,
    turnId?: string,
  ): Promise<boolean> {
    const cfg = this.options.config.compaction;
    const window = this.compactionWindow();
    if (!window) return false;
    const before = promptTokens(s.header.system, contextOf(s.messages), specsJson);
    if (!force && before < window * cfg.threshold) return false;

    const latest = latestMarker(s.messages);
    const start = latest ? latest.part.keepFrom : 0;
    // On request, compact meaningfully even far below the threshold.
    const keep = force ? Math.min(window * cfg.keepRecent, before * 0.25) : window * cfg.keepRecent;
    const keepFrom = chooseBoundary(s.messages, start, keep);
    if (keepFrom === undefined) return false;

    const summarizer = this.summarizerModel(before, s);
    if (!summarizer) {
      this.notify('warn', 'context is large but no model is available to summarize it');
      return false;
    }
    const provider = this.providers.get(summarizer.ref.provider);
    if (!provider) return false;
    if (summarizer.tier === 'remote' && turnId)
      this.emit({
        type: 'route.decided',
        ...this.scope(s),
        turnId,
        tier: 'remote',
        model: summarizer.ref,
        rule: 'compaction',
        reason: 'no local model is reachable to summarize earlier context',
      });

    // Fold chunks that fit the summarizer's window into a running summary.
    const budget = Math.floor(summarizer.contextWindow * 0.5);
    const blocks = renderForSummary(s.messages.slice(start, keepFrom));
    let summary = latest?.part.summary;
    let chunk: string[] = [];
    let chunkTokens = 0;
    const flush = async () => {
      if (!chunk.length) return;
      summary = await this.summarize(s, provider, summarizer, summary, chunk.join('\n\n'), signal);
      chunk = [];
      chunkTokens = 0;
    };
    for (const block of blocks) {
      const n = countTokens(block);
      const text = n > budget ? `${block.slice(0, budget * 3)}\n... (truncated)` : block;
      if (chunkTokens + Math.min(n, budget) > budget) await flush();
      chunk.push(text);
      chunkTokens += Math.min(n, budget);
    }
    await flush();
    if (!summary || signal.aborted) return false;

    const marker: Message = {
      role: 'user',
      parts: [{ type: 'compaction', summary, keepFrom, tokensBefore: before, tokensAfter: 0 }],
    };
    const part = marker.parts[0] as Extract<Message['parts'][number], { type: 'compaction' }>;
    part.tokensAfter = promptTokens(s.header.system, contextOf([...s.messages, marker]), specsJson);
    this.append(s, marker);
    this.emit({
      type: 'context.compacted',
      ...this.scope(s),
      messages: keepFrom - start,
      tokensBefore: before,
      tokensAfter: part.tokensAfter,
    });
    return true;
  }

  /**
   * Local first: the first reachable local model. A remote model only when
   * routing allows remote and the budget isn't spent (local never silently
   * costs money).
   */
  private summarizerModel(tokens: number, s?: LiveSession): ModelInfo | undefined {
    const routing = this.options.config.routing;
    const inRoles = roleAliases(routing).flatMap((a) => this.modelInfo(a) ?? []);
    const local = inRoles.find((m) => m.tier === 'local' && m.available);
    if (local) return local;
    if (!routing.allowRemote || s?.private) return undefined;
    const spend = this.ledger.spend();
    const b = routing.budget;
    if (
      (b.dailyUsd && spend.todayUsd >= b.dailyUsd) ||
      (b.monthlyUsd && spend.monthUsd >= b.monthlyUsd)
    )
      return undefined;
    return inRoles.find(
      (m) => m.tier === 'remote' && m.available && m.contextWindow > Math.min(tokens, 16_000),
    );
  }

  private async summarize(
    s: LiveSession,
    provider: Provider,
    model: ModelInfo,
    previous: string | undefined,
    chunk: string,
    signal: AbortSignal,
  ): Promise<string> {
    const request = summaryRequest(previous, chunk);
    const text =
      model.tier === 'remote' && this.options.config.privacy.secrets !== 'off'
        ? (await redactSecrets(request)).text
        : request;
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    for await (const ev of provider.stream({
      model: model.ref.model,
      system: SUMMARIZER_PROMPT,
      messages: [{ role: 'user', parts: [{ type: 'text', text }] }],
      tools: [],
      maxTokens: 4_000,
      signal,
    })) {
      if (ev.type === 'done') done = ev;
    }
    if (!done) throw new Error(`${provider.id} ended the summary without a result`);
    this.recordUsage(s, model.tier, model.ref, done.usage, {
      rule: 'compaction',
      agent: s.header.agent,
    });
    const summary = done.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('')
      .trim();
    if (!summary) throw new Error(`${model.alias} returned an empty summary`);
    return summary;
  }

  private async runTools(
    s: LiveSession,
    tools: Tool[],
    catalog: ToolContext['agentCatalog'],
    calls: { id: string; name: string; input: unknown }[],
    turnId: string,
    signal: AbortSignal,
    tier: Tier,
    /** The alias of the model that made these calls, for review. */
    writer: string,
  ): Promise<ToolResultPart[]> {
    const ctx: ToolContext = {
      workspaceRoot: this.rootOf(s),
      sessionId: s.header.id,
      signal,
      agentCatalog: catalog,
      runSubagent: (agent, prompt, description, options) =>
        this.runSubagent(s, agent, prompt, description, signal, options),
    };
    const matches = this.privatePaths();
    const runOne = async (call: (typeof calls)[number]): Promise<ToolResultPart> => {
      const tool = tools.find((t) => t.name === call.name);
      // A subagent that saw private content passes that on with its report.
      let fromSubagent: string | undefined;
      const callCtx: ToolContext = {
        ...ctx,
        runSubagent: async (agent, prompt, description, options) => {
          const r = await this.runSubagent(s, agent, prompt, description, signal, options);
          if (r.private) fromSubagent ??= r.private;
          return r;
        },
      };
      const parsed = tool?.schema.safeParse(call.input);
      if (!tool || !parsed?.success) {
        s.signals.recordMalformedToolCall();
        const message = !tool
          ? `unknown tool "${call.name}"; available: ${tools.map((t) => t.name).join(', ')}`
          : `invalid arguments: ${parsed?.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
        this.emit({
          type: 'tool.completed',
          ...this.scope(s),
          turnId,
          callId: call.id,
          name: call.name,
          output: message,
          isError: true,
        });
        return { type: 'tool_result', callId: call.id, content: message, isError: true };
      }
      s.signals.recordToolCall(call.name, parsed.data);
      this.emit({
        type: 'tool.started',
        ...this.scope(s),
        turnId,
        callId: call.id,
        name: call.name,
        input: parsed.data,
      });

      let output: string;
      let isError = false;
      let ran = false;
      const permission = await this.checkPermission(s, tool, parsed.data, callCtx, signal);
      if (!permission.allowed) {
        output =
          permission.error ??
          'The user denied this action. Do not retry it; ask the user how to proceed.';
        isError = true;
      } else {
        ran = true;
        if (tool.name === 'edit' || tool.name === 'write')
          this.noteEdit(s, (parsed.data as { path: string }).path, writer);
        try {
          output = await tool.run(parsed.data, callCtx);
        } catch (err) {
          output = (err as Error).message;
          isError = true;
        }
      }
      s.signals.recordToolResult(!isError);
      // Even a failed call may have printed private content (a bash error, say).
      const priv =
        fromSubagent ??
        (ran && matches
          ? privateToolUse(matches, ctx.workspaceRoot, call.name, parsed.data, output)
          : undefined);
      this.emit({
        type: 'tool.completed',
        ...this.scope(s),
        turnId,
        callId: call.id,
        name: call.name,
        output,
        isError,
        ...(priv ? { private: priv } : {}),
      });
      return {
        type: 'tool_result',
        callId: call.id,
        content: output,
        ...(isError ? { isError } : {}),
        ...(priv ? { private: priv } : {}),
      };
    };

    const allParallelSafe = calls.every(
      (c) => tools.find((t) => t.name === c.name)?.mutating === false,
    );
    if (allParallelSafe) return Promise.all(calls.map(runOne));
    const results: ToolResultPart[] = [];
    for (const call of calls) {
      if (signal.aborted) {
        results.push({ type: 'tool_result', callId: call.id, content: 'cancelled', isError: true });
        continue;
      }
      results.push(await runOne(call));
    }
    return results;
  }

  private async runSubagent(
    parent: LiveSession,
    agent: string,
    prompt: string,
    description: string,
    signal: AbortSignal,
    options: { background?: boolean; isolation?: 'worktree' } = {},
  ): Promise<SubagentResult> {
    const depth = parent.depth + 1;
    let slots = this.subagentSlots.get(depth);
    if (!slots) {
      // One pool per depth: a parent holding a slot never waits on its own children.
      slots = new Semaphore(this.options.config.subagents.maxConcurrent);
      this.subagentSlots.set(depth, slots);
    }
    const isolate =
      options.isolation === 'worktree' || this.agents.get(agent)?.isolation === 'worktree';
    let worktree: Worktree | undefined;
    if (isolate) {
      const id = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      worktree = await createWorktree(this.rootOf(parent), this.worktreeDir(), id).catch(
        (err: Error) => {
          throw new ToolError(err.message);
        },
      );
    }
    const child = this.createSession({
      agent,
      title: description,
      parentId: parent.header.id,
      ...(worktree ? { worktree } : {}),
    });
    const limitUsd = this.agents.get(agent)?.budgetUsd ?? this.options.config.subagents.budgetUsd;
    const childSession = this.sessions.get(child.id);
    if (childSession && limitUsd !== undefined) childSession.budget = { agent, limitUsd };
    const background = options.background === true;
    // Background work outlives the turn that started it; the session cancels it.
    parent.bgController ??= new AbortController();
    const runSignal = background ? parent.bgController.signal : signal;

    const run = async (): Promise<SubagentResult> => {
      await slots.acquire(runSignal);
      try {
        this.emit({
          type: 'subagent.started',
          ...this.scope(parent),
          childSessionId: child.id,
          agent,
          task: description,
          ...(background ? { background } : {}),
        });
        const def = this.agents.get(agent);
        const childLive = this.sessions.get(child.id);
        // The brief was written with the parent's context, so it's private if that is.
        if (childLive && parent.private) childLive.private = `from its parent: ${parent.private}`;
        const result =
          def?.runtime && childLive
            ? await this.runExternal(childLive, def, prompt, runSignal)
            : await this.runTurn(child.id, prompt, 'auto', undefined, runSignal, [], {
                ...(parent.private ? { private: `from its parent: ${parent.private}` } : {}),
              });
        const ok = result.stopReason === 'end_turn';
        this.emit({
          type: 'subagent.completed',
          ...this.scope(parent),
          childSessionId: child.id,
          agent,
          ok,
          ...(background ? { background } : {}),
        });
        const text = ok
          ? result.text
          : `${result.stopReason}: ${this.sessions.get(child.id)?.lastError ?? result.text}`;
        const priv = this.sessions.get(child.id)?.private;
        return {
          ok,
          text: worktree ? await this.finishIsolated(worktree, ok, description, text) : text,
          sessionId: child.id,
          ...(priv && !parent.private ? { private: `subagent ${agent}: ${priv}` } : {}),
        };
      } finally {
        slots.release();
      }
    };

    if (!background) return run();
    const done = run()
      .then((r) => {
        // Cancelled with the session: the report is dropped, not delivered.
        if (!runSignal.aborted) this.deliver(parent, child.id, agent, description, r);
      })
      .catch(() => {
        // Cancelled with the session: nothing to deliver.
      })
      .finally(() => parent.background.delete(child.id));
    parent.background.set(child.id, done);
    return { ok: true, text: '', sessionId: child.id };
  }

  private runtime(name: string): AgentRuntime | undefined {
    const injected = this.options.runtimes?.get(name);
    if (injected) return injected;
    const cfg = this.options.config.runtimes[name];
    if (!cfg) return undefined;
    return new ClaudeAgentSdkRuntime({
      name,
      ...(cfg.model ? { model: cfg.model } : {}),
      ...(cfg.maxTurns ? { maxTurns: cfg.maxTurns } : {}),
      ...(cfg.executable ? { executable: cfg.executable } : {}),
    });
  }

  /**
   * Run a subagent on an external runtime (ADR 0009). It's remote spend, so it
   * obeys routing like any remote call; its tools go through the permission
   * policy; its progress is emitted on the child session; its cost is ledgered.
   */
  private async runExternal(
    s: LiveSession,
    agent: AgentDefinition,
    prompt: string,
    parentSignal: AbortSignal,
  ): Promise<TurnResult> {
    const turnId = `turn_${crypto.randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    parentSignal.addEventListener('abort', onAbort, { once: true });
    s.controller = controller;
    const name = agent.runtime as string;
    this.emit({ type: 'turn.started', ...this.scope(s), turnId });
    this.append(s, { role: 'user', parts: [{ type: 'text', text: prompt }] });
    const fail = (message: string): TurnResult => {
      s.lastError = message;
      this.emit({ type: 'error', ...this.scope(s), turnId, message });
      return { stopReason: 'error', text: '' };
    };
    let result: TurnResult;
    try {
      const runtime = this.runtime(name);
      const routing = this.options.config.routing;
      const spend = this.ledger.spend();
      const b = routing.budget;
      const over =
        (b.dailyUsd !== undefined && spend.todayUsd >= b.dailyUsd) ||
        (b.monthlyUsd !== undefined && spend.monthUsd >= b.monthlyUsd);
      const budget = this.invocationBudget(s).invocationBudget;
      if (!runtime)
        result = fail(
          `agent "${agent.name}" names runtime "${name}", which isn't configured under runtimes`,
        );
      else if (this.options.org?.remoteDisabled)
        result = fail(`external runtimes are disabled by ${this.options.org.name} policy`);
      else if (!routing.allowRemote)
        result = fail(
          'remote models are turned off (routing.allowRemote); external runtimes are remote',
        );
      else if (s.private)
        result = fail(
          `this task carries private content (${s.private}), which never leaves this machine; external runtimes are remote`,
        );
      else if (over) result = fail('the remote budget is spent');
      else if (budget && budget.spentUsd >= budget.limitUsd)
        result = fail(
          `subagent "${budget.agent}" has spent its $${budget.limitUsd.toFixed(2)} budget`,
        );
      else {
        const model = { provider: name, model: this.options.config.runtimes[name]?.model ?? name };
        this.emit({
          type: 'route.decided',
          ...this.scope(s),
          turnId,
          tier: 'remote',
          model,
          rule: 'runtime',
          reason: `agent "${agent.name}" runs on ${runtime.label}`,
        });
        const ctx: ToolContext = {
          workspaceRoot: this.rootOf(s),
          sessionId: s.header.id,
          signal: controller.signal,
          agentCatalog: [],
        };
        const r = await runtime.run({
          prompt,
          cwd: this.rootOf(s),
          signal: controller.signal,
          ...(budget ? { budgetUsd: Math.max(0, budget.limitUsd - budget.spentUsd) } : {}),
          canUseTool: async (tool, input) => {
            // The runtime's model is remote: it may not read private files.
            const i = (input ?? {}) as Record<string, unknown>;
            const matches = this.privatePaths();
            const named = matches
              ? (privateToolUse(
                  matches,
                  ctx.workspaceRoot,
                  'read',
                  { path: i.file_path ?? i.path },
                  '',
                ) ?? privateToolUse(matches, ctx.workspaceRoot, 'bash', { command: i.command }, ''))
              : undefined;
            if (named)
              return {
                allowed: false,
                message: `${named.replace(/^(read|a command named) /, '')} is private (privacy.localOnlyPaths) and can't be sent to a remote model`,
              };
            const p = await this.checkPermission(
              s,
              externalTool(tool),
              input,
              ctx,
              controller.signal,
            );
            return { allowed: p.allowed, ...(p.error ? { message: p.error } : {}) };
          },
          onEvent: (ev) => {
            if (ev.type === 'text')
              this.emit({ type: 'text.delta', ...this.scope(s), turnId, text: ev.text });
            else if (ev.type === 'tool.started')
              this.emit({
                type: 'tool.started',
                ...this.scope(s),
                turnId,
                callId: ev.callId,
                name: ev.name,
                input: ev.input,
              });
            else
              this.emit({
                type: 'tool.completed',
                ...this.scope(s),
                turnId,
                callId: ev.callId,
                name: ev.name,
                output: ev.output,
                isError: ev.isError,
              });
          },
        });
        for (const call of r.calls)
          this.recordUsage(s, 'remote', call.model, call.usage, {
            rule: 'runtime',
            agent: agent.name,
            costUsd: call.costUsd,
          });
        this.append(s, {
          role: 'assistant',
          parts: [{ type: 'text', text: r.text }],
          meta: { model, tier: 'remote', routeReason: `runs on ${runtime.label}` },
        });
        result = r.ok
          ? { stopReason: 'end_turn', text: r.text }
          : controller.signal.aborted
            ? { stopReason: 'cancelled', text: r.text }
            : fail(r.text);
      }
    } finally {
      s.controller = undefined;
      parentSignal.removeEventListener('abort', onAbort);
    }
    this.emit({ type: 'turn.completed', ...this.scope(s), turnId, stopReason: result.stopReason });
    return result;
  }

  /** Worktrees live in the data directory, one folder per repository. */
  private worktreeDir(): string {
    const id = createHash('sha256').update(this.options.workspaceRoot).digest('hex').slice(0, 12);
    return join(this.options.dataDir ?? switchbackPaths().dataDir, 'worktrees', id);
  }

  /**
   * Turn an isolated subagent's outcome into its report: on success, commit to
   * its branch, remove the worktree, and include the diff; on failure, keep
   * the worktree for inspection.
   */
  private async finishIsolated(
    wt: Worktree,
    ok: boolean,
    description: string,
    text: string,
  ): Promise<string> {
    if (!ok)
      return `${text}\n\nThe worktree is kept for inspection at ${wt.path} (branch ${wt.branch}).`;
    try {
      const r = await finishWorktree(wt, `switchback: ${description}`);
      if (!r.changed) return `${text}\n\n(Isolated in a worktree; it made no file changes.)`;
      return `${text}\n\nChanges are committed on branch \`${wt.branch}\` (from ${wt.base.slice(0, 8)}); your working tree is unchanged. Review and merge them if you want them, e.g. \`git merge ${wt.branch}\`.\n\n${r.stat}\n\n${truncate(r.diff, 20_000)}`;
    } catch (err) {
      return `${text}\n\nCould not finish the worktree (${(err as Error).message}); it is kept at ${wt.path} (branch ${wt.branch}).`;
    }
  }

  /**
   * A background subagent finished: queue its report for the parent. A busy
   * parent picks it up at its next step; an idle top-level session starts a
   * follow-up turn so the agent can act on it.
   */
  private deliver(
    parent: LiveSession,
    childId: string,
    agent: string,
    description: string,
    result: SubagentResult,
  ): void {
    parent.inbox.push({
      type: 'text',
      text: `Background task "${description}" (${agent}) ${result.ok ? 'finished' : 'failed'}:\n\n${result.text || '(no report)'}`,
      backgroundTask: { sessionId: childId, agent, ok: result.ok },
      ...(result.private ? { private: result.private } : {}),
    });
    if (!parent.controller && !parent.header.parentId) {
      void this.runTurn(parent, '', 'auto', undefined, undefined, [], {
        waitForBackground: false,
      }).catch((err) => this.notify('error', (err as Error).message));
    }
  }

  /** Append waiting background reports as one user message, at a step boundary. */
  private drainInbox(s: LiveSession): void {
    if (!s.inbox.length) return;
    this.append(s, { role: 'user', parts: s.inbox.splice(0) });
  }

  // -------------------------------------------------------------------------
  // Permissions and escalation prompts
  // -------------------------------------------------------------------------

  /**
   * Decide whether a tool call may run. `allowed: false` with an `error` means
   * the call would fail anyway (found while building the preview), so the
   * user is never asked about it.
   */
  private async checkPermission(
    s: LiveSession,
    tool: Tool,
    input: unknown,
    ctx: ToolContext,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; error?: string }> {
    if (tool.permission === 'none') return { allowed: true };
    const category = this.options.config.permissions[tool.permission];
    // deny first: an org can enforce it, and neither a per-server setting nor a
    // session grant may override that.
    if (category === 'deny') return { allowed: false };
    const level = tool.permissionLevel ?? category;
    if (level === 'deny') return { allowed: false };
    const key = tool.permissionKey ?? tool.permission;
    if (level === 'allow' || this.alwaysAllowed.has(key)) return { allowed: true };
    const mode = this.options.interaction ?? 'prompt';
    if (mode !== 'prompt') return { allowed: mode === 'approve' };

    let preview: ToolPreview | undefined;
    try {
      preview = await tool.preview?.(input, ctx);
    } catch (err) {
      return { allowed: false, error: (err as Error).message };
    }

    const requestId = `perm_${crypto.randomUUID().slice(0, 8)}`;
    const decision = await this.waitFor(
      this.pendingPermissions,
      requestId,
      signal,
      'deny' as PermissionDecision,
      () =>
        this.emit({
          type: 'permission.requested',
          ...this.scope(s),
          requestId,
          tool: tool.name,
          summary: tool.summarize(input),
          input,
          ...(preview ? { preview: preview.diff } : {}),
          ...(preview?.proposed ? { proposed: preview.proposed } : {}),
        }),
    );
    // Every client clears the prompt, whichever one answered (or none, on cancel).
    this.emit({ type: 'permission.resolved', ...this.scope(s), requestId, decision });
    if (decision === 'allow_always') this.alwaysAllowed.add(tool.permissionKey ?? tool.permission);
    return { allowed: decision !== 'deny' };
  }

  private async askEscalation(
    s: LiveSession,
    target: ModelRef,
    reason: string,
    estimatedCostUsd: number | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const mode = this.options.interaction ?? 'prompt';
    // Headless runs never spend money they were not told they could spend.
    if (mode !== 'prompt') return false;
    const requestId = `esc_${crypto.randomUUID().slice(0, 8)}`;
    const approved = await this.waitFor(this.pendingEscalations, requestId, signal, false, () =>
      this.emit({
        type: 'escalation.requested',
        ...this.scope(s),
        requestId,
        reason,
        target,
        ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      }),
    );
    this.emit({ type: 'escalation.resolved', ...this.scope(s), requestId, approved });
    return approved;
  }

  private waitFor<T>(
    pending: Map<string, (v: T) => void>,
    requestId: string,
    signal: AbortSignal,
    onAbort: T,
    announce: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const abort = () => {
        pending.delete(requestId);
        resolve(onAbort);
      };
      signal.addEventListener('abort', abort, { once: true });
      pending.set(requestId, (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      });
      announce();
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private live(sessionId: string): LiveSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const stored = this.store.load(sessionId);
    if (!stored) throw new RpcError(ErrorCode.SessionNotFound, `session ${sessionId} not found`);
    const parent = stored.header.parentId ? this.sessions.get(stored.header.parentId) : undefined;
    const live: LiveSession = {
      header: stored.header,
      messages: stored.messages,
      updatedAt: this.now().toISOString(),
      signals: new SignalTracker(this.options.config.routing.escalation),
      depth: parent ? parent.depth + 1 : stored.header.parentId ? 1 : 0,
      background: new Map(),
      inbox: [],
      ...(privateReason(stored.messages) ? { private: privateReason(stored.messages) } : {}),
    };
    this.sessions.set(sessionId, live);
    return live;
  }

  private append(s: LiveSession, message: Message): void {
    s.private ??= privateReason([message]);
    s.messages.push(message);
    s.updatedAt = this.now().toISOString();
    this.store.append(s.header.id, message);
  }

  /** Matcher for `privacy.localOnlyPaths`, rebuilt when the patterns change. */
  private privatePaths(): PrivatePathMatcher | undefined {
    const patterns = this.options.config.privacy.localOnlyPaths;
    const key = JSON.stringify(patterns);
    if (this.privateMatcher?.key !== key)
      this.privateMatcher = { key, matches: privatePathMatcher(patterns) };
    return this.privateMatcher.matches;
  }

  /**
   * Why this session must stay local: private content in it, or (with
   * `privacy.secrets: block`) a secret in what would be sent.
   */
  private async privacyOf(s: LiveSession): Promise<{ privacy?: { reason: string } }> {
    if (s.private) return { privacy: { reason: s.private } };
    if (this.options.config.privacy.secrets !== 'block') return {};
    const { found } = await redactOutbound(s.header.system, contextOf(s.messages));
    return found.length
      ? { privacy: { reason: `the conversation contains a secret (${found[0]})` } }
      : {};
  }

  /** What a model is sent: for remote models, with secrets redacted (`privacy.secrets`). */
  private async outbound(
    s: LiveSession,
    model: ModelInfo,
    system: string,
    messages: Message[],
  ): Promise<{ system: string; messages: Message[] }> {
    if (model.tier !== 'remote' || this.options.config.privacy.secrets !== 'redact')
      return { system, messages };
    const r = await redactOutbound(system, messages);
    // Each request resends the conversation; report only when more are found.
    if (r.found.length > (s.redacted ?? 0))
      this.emit({ type: 'secrets.redacted', ...this.scope(s), kinds: r.found, model: model.ref });
    s.redacted = r.found.length;
    return r;
  }

  private recordUsage(
    s: LiveSession,
    tier: Tier,
    model: ModelRef,
    usage: Usage,
    meta: { rule: string; agent: string; costUsd?: number },
  ): void {
    this.ledger.record(s.header.id, tier, model, usage, meta);
    if (tier === 'remote') this.checkCache(s, model, usage);
    const total = this.ledger.sessionCost(s.header.id);
    this.emit({
      type: 'usage.updated',
      ...this.scope(s),
      usage: total.usage,
      costUsd: total.costUsd,
      savingsUsd: total.savingsUsd,
      tier,
    });
  }

  /**
   * Consecutive calls to one remote model within the cache lifetime share a
   * prefix (append-only transcript, frozen system prompt, fixed tool order),
   * so they should read from the provider's cache. A miss means something is
   * changing the prefix and every call is paying full price; say so once.
   */
  private checkCache(s: LiveSession, model: ModelRef, usage: Usage): void {
    const key = `${model.provider}/${model.model}`;
    const at = this.now().getTime();
    const prev = s.lastRemote;
    s.lastRemote = { key, at };
    if (s.cacheWarned || !prev || prev.key !== key || at - prev.at > CACHE_TTL_MS) return;
    const read = usage.cacheReadTokens ?? 0;
    const prompt = usage.inputTokens + read + (usage.cacheWriteTokens ?? 0);
    if (read > 0 || prompt < CACHE_CHECK_MIN_TOKENS) return;
    s.cacheWarned = true;
    this.emit({
      type: 'log',
      level: 'warn',
      message: `${key}: no prompt-cache hit on a follow-up call (${prompt} input tokens at full price). The provider may not cache this model, or the prompt prefix is changing between calls.`,
    });
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
    };
  }

  /** Whether any session has a turn in progress (daemons stay up while busy). */
  busy(): boolean {
    for (const s of this.sessions.values()) if (s.controller || s.background.size) return true;
    return false;
  }

  /** Where a session's tools operate: its worktree, or the workspace. */
  private rootOf(s: LiveSession): string {
    return s.header.worktree?.root ?? this.options.workspaceRoot;
  }

  private systemPrompt(agent: AgentDefinition, root = this.options.workspaceRoot): string {
    const isolated =
      root !== this.options.workspaceRoot
        ? '\nYou are working in an isolated git worktree on your own branch. Edit freely; the parent agent decides whether to merge your changes. Do not commit, push, or switch branches.'
        : '';
    const sections = [
      agent.prompt,
      `# Environment\nWorkspace root: ${root}${isolated}\nPlatform: ${process.platform}\nShell for the bash tool: ${currentShell().name}\nFile paths in tool calls are relative to the workspace root.`,
    ];
    if (this.options.instructions)
      sections.push(`# Project instructions\n${this.options.instructions.trim()}`);
    return sections.join('\n\n');
  }

  private tierOfProvider(providerId: string): Tier {
    const pc = this.options.config.providers[providerId];
    return pc ? tierOf(pc) : (this.providers.get(providerId)?.tier ?? 'remote');
  }

  private modelInfo(alias: string): ModelInfo | undefined {
    const m = this.options.config.models[alias];
    if (!m) return undefined;
    return {
      alias,
      ref: { provider: m.provider, model: m.model },
      tier: this.tierOfProvider(m.provider),
      contextWindow: this.contextWindowOf(alias),
      available: this.health.get(m.provider)?.ok ?? true,
    };
  }

  /**
   * Prompt size for routing. A tokenizer estimate, replaced by the local
   * server's exact count when the estimate is close enough to the local
   * threshold that the difference could change the decision.
   */
  private async countPrompt(s: LiveSession, specsJson: string, signal: AbortSignal) {
    const messages = contextOf(s.messages);
    const estimate = promptTokens(s.header.system, messages, specsJson);
    const routing = this.options.config.routing;
    // With several local models, ask the first reachable one whose threshold
    // is close; the others either clearly fit or clearly don't.
    for (const alias of routing.start) {
      const local = this.modelInfo(alias);
      if (local?.tier !== 'local' || !local.available) continue;
      if (!nearThreshold(estimate, local.contextWindow * routing.escalation.contextHeadroom))
        continue;
      const provider = this.providers.get(local.ref.provider);
      const exact = await provider
        ?.countTokens?.(local.ref.model, promptText(s.header.system, messages, specsJson), signal)
        .catch(() => undefined);
      // The server counts raw text; add the same per-message template allowance.
      if (exact !== undefined) return exact + PER_MESSAGE_OVERHEAD * messages.length;
    }
    return estimate;
  }

  /** Configured window, else what the server reported, else a conservative guess. */
  private contextWindowOf(alias: string): number {
    const m = this.options.config.models[alias];
    if (m?.contextWindow) return m.contextWindow;
    const detected = this.detectedContext.get(alias);
    if (detected) return detected;
    return m && this.tierOfProvider(m.provider) === 'local'
      ? UNKNOWN_LOCAL_CONTEXT
      : UNKNOWN_REMOTE_CONTEXT;
  }

  /** Ask servers for the context window of models whose config leaves it out (once each). */
  private async detectContextWindows(): Promise<void> {
    await Promise.all(
      Object.entries(this.options.config.models).map(async ([alias, m]) => {
        if (m.contextWindow || this.detectedContext.has(alias)) return;
        if (!this.health.get(m.provider)?.ok) return;
        const provider = this.providers.get(m.provider);
        const found = await provider?.contextWindow?.(m.model).catch(() => undefined);
        this.detectedContext.set(alias, found?.contextWindow ?? null);
        this.emit({
          type: 'log',
          level: found ? 'info' : 'warn',
          message: found
            ? `${alias}: context window ${found.contextWindow} (from ${found.source})`
            : `${alias}: context window unknown; assuming ${this.contextWindowOf(alias)}. Set models.${alias}.contextWindow.`,
        });
      }),
    );
  }

  private async refreshHealth(signal: AbortSignal): Promise<void> {
    const now = this.now().getTime();
    const used = new Set(Object.values(this.options.config.models).map((m) => m.provider));
    await Promise.all(
      [...used].map(async (id) => {
        const cached = this.health.get(id);
        if (cached && now - cached.at < (cached.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_FAIL_MS)) return;
        const provider = this.providers.get(id);
        if (!provider) return;
        const status = await provider.health(signal).catch(() => ({ ok: false }));
        this.health.set(id, { ok: status.ok, at: this.now().getTime() });
      }),
    );
    await this.detectContextWindows();
  }
}

/**
 * A stand-in Tool for a call an external runtime wants to make, so the
 * engine's permission policy applies. Unknown tools are treated like `bash`.
 */
function externalTool(name: string): Tool {
  const category: Tool['permission'] = /^(Read|Glob|Grep|LS|NotebookRead|TodoWrite|Task)$/.test(
    name,
  )
    ? 'read'
    : /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name)
      ? 'edit'
      : name.startsWith('mcp__')
        ? 'mcp'
        : 'bash';
  return {
    name,
    description: '',
    schema: z.unknown(),
    permission: category,
    permissionKey: category === 'mcp' ? `mcp:${name.split('__')[1] ?? ''}` : category,
    mutating: category !== 'read',
    summarize: (input) => {
      const args = JSON.stringify(input ?? {});
      return `${name} ${args.length > 120 ? `${args.slice(0, 120)}…` : args}`;
    },
    run: async () => {
      throw new Error('external tools run in their runtime');
    },
  };
}
