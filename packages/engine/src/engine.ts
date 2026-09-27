/**
 * The engine: owns sessions, routing, providers, tools, permissions, and
 * subagents. Clients (TUI, VS Code, headless) drive it only through the
 * protocol methods mirrored here and observe it only through `EngineEvent`s.
 */
import { existsSync, readFileSync } from 'node:fs';
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
  type SessionSummary,
  type StopReason,
  type TextPart,
  type Tier,
  type ToolResultPart,
  textOf,
  type Usage,
  type UsagePeriod,
  type UsageReport,
} from '@harness/protocol';
import {
  type ChatEvent,
  createProvider,
  type Price,
  type Provider,
  ProviderError,
  tierOf,
} from '@harness/providers';
import { type Difficulty, type ModelInfo, Router, SignalTracker } from '@harness/router';
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
import type { HarnessConfig } from './config.ts';
import { estimateEscalationCost } from './estimate.ts';
import { type LedgerEntry, UsageLedger } from './ledger.ts';
import { allowsMcpTool, McpHub } from './mcp/hub.ts';
import { expandAttachments, expandMentions } from './mentions.ts';
import type { OrgStatus } from './org/policy.ts';
import { harnessPaths, projectPaths } from './paths.ts';
import { Semaphore } from './semaphore.ts';
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
  type SubagentResult,
  type Tool,
  type ToolContext,
  type ToolPreview,
  toolSpec,
  toolsFor,
} from './tools/index.ts';
import { currentShell } from './tools/shell.ts';

export const ENGINE_VERSION = '0.4.0';

export interface EngineOptions {
  workspaceRoot: string;
  config: HarnessConfig;
  prices?: Record<string, Price>;
  /** Override provider construction (tests, embedding). Keyed by provider id. */
  providers?: Map<string, Provider>;
  store?: SessionStore;
  ledgerFile?: string;
  agents?: Map<string, AgentDefinition>;
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

/** The model whose prices define "saved": the first configured remote model. */
function referenceModel(config: HarnessConfig): string | undefined {
  const alias = config.routing.remote.find((a) => config.models[a]);
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
  private readonly agents: Map<string, AgentDefinition>;
  private readonly now: () => Date;
  private mcp: McpHub | undefined;

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

  private startMcp(config: HarnessConfig): McpHub | undefined {
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
          error: `defined in ${u.source}; run \`harness mcp trust\` to allow it`,
        })),
      ],
    };
  }

  /** Build an engine from disk: agents, instructions, persistent store, and ledger. */
  static fromWorkspace(
    workspaceRoot: string,
    config: HarnessConfig,
    extra: Partial<EngineOptions> = {},
  ): { engine: Engine; agentErrors: string[] } {
    const hp = harnessPaths();
    const pp = projectPaths(workspaceRoot);
    const { agents, errors } = loadAgents([
      { dir: hp.agentsDir, source: 'user' },
      { dir: pp.claudeAgentsDir, source: 'claude-compat' },
      { dir: pp.agentsDir, source: 'project' },
    ]);
    const instructionFile = pp.instructionFiles.find((f) => existsSync(f));
    const instructions = instructionFile ? readFileSync(instructionFile, 'utf8') : undefined;
    const engine = new Engine({
      workspaceRoot,
      config,
      agents,
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
    return [...this.agents.values()].map(summarize);
  }

  createSession(params: { agent?: string; title?: string; parentId?: string }): SessionSummary {
    const agentName = params.agent ?? this.options.config.defaultAgent;
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
      createdAt: now,
      system: this.systemPrompt(agent),
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

  /** Start a turn and return immediately; progress arrives as events. */
  prompt(params: {
    sessionId: string;
    text: string;
    route?: RoutePreference;
    attachments?: Attachment[];
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
      { waitForBackground: false },
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
    options: { waitForBackground?: boolean } = {},
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
      const attachments = [
        ...(await expandAttachments(extra, this.options.workspaceRoot).catch(() => [])),
        ...(await expandMentions(text, this.options.workspaceRoot).catch(() => [])),
      ];
      this.append(session, { role: 'user', parts: [{ type: 'text', text }, ...attachments] });
    }
    session.signals.startUserTurn();

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
    config: HarnessConfig;
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

  usage(period?: UsagePeriod): UsageReport {
    return this.ledger.report(this.options.config.routing.budget, period);
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
      const decision = this.router.decide({
        preference,
        escalationDeclined: forceLocal,
        refused,
        refusalRetry,
        ...(difficulty ? { difficulty } : {}),
        ...this.invocationBudget(s),
        agent: {
          name: agent.name,
          route: agent.route,
          ...(agent.model ? { model: agent.model } : {}),
        },
        estimatedInputTokens: inputTokens,
        signals: s.signals.snapshot(),
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
      });
      const provider = this.providers.get(model.ref.provider);
      if (!provider) throw new Error(`provider "${model.ref.provider}" is not configured`);
      const modelConfig = this.options.config.models[model.alias];

      let done: Extract<ChatEvent, { type: 'done' }> | undefined;
      try {
        for await (const ev of provider.stream({
          model: model.ref.model,
          system: s.header.system,
          // A fresh array (so providers never observe later appends), built
          // from the latest compaction marker.
          messages: contextOf(s.messages),
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
        if (model.tier === 'local') s.signals.recordLocalFailure();
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
      s.signals.recordTurn(model.tier, escalated);
      escalationApproved = false;

      const toolCalls = done.parts.filter((p) => p.type === 'tool_call');
      const truncatedTools = done.stopReason === 'max_tokens' && toolCalls.length > 0;

      // A remote refusal is retried on the next remote model, if there is one.
      // The refused output is discarded, not added to the transcript.
      if (model.tier === 'remote' && done.stopReason === 'refusal') {
        const routing = this.options.config.routing;
        const others = routing.remote.filter(
          (a) => a !== model.alias && !refused.includes(a) && this.options.config.models[a],
        );
        if (others.length) {
          refused.push(model.alias);
          refusalRetry = true;
          continue;
        }
      }

      // A local model that refuses or runs out of room gets one more chance on
      // the remote tier instead of ending the user's turn.
      if (model.tier === 'local' && (done.stopReason === 'refusal' || truncatedTools)) {
        s.signals.recordLocalFailure();
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

      const results = await this.runTools(s, tools, catalog, toolCalls, turnId, signal);
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
    if (!c || preference !== 'auto' || routing.mode !== 'auto') return undefined;
    if (agent.model || agent.route !== 'auto' || s.signals.snapshot().stickyRemoteTurns > 0)
      return undefined;
    if (!routing.remote.some((a) => this.options.config.models[a])) return undefined;
    const model = this.modelInfo(c.model);
    if (!model || model.tier !== 'local') {
      this.notify('warn', `routing.classifier.model "${c.model}" must be a configured local model`);
      return undefined;
    }
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
      this.recordUsage(s, 'local', model.ref, r.usage, { rule: 'classify', agent: agent.name });
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
  // Compaction (ADR 0008)
  // -------------------------------------------------------------------------

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

  /** The window compaction keeps a session inside: the largest local one, else the remote one. */
  private compactionWindow(): number | undefined {
    const routing = this.options.config.routing;
    const locals = routing.local.flatMap((a) => this.modelInfo(a) ?? []);
    if (locals.length) return Math.max(...locals.map((m) => m.contextWindow));
    const remote = routing.remote.flatMap((a) => this.modelInfo(a) ?? [])[0];
    return remote?.contextWindow;
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

    const summarizer = this.summarizerModel(before);
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
  private summarizerModel(tokens: number): ModelInfo | undefined {
    const routing = this.options.config.routing;
    const local = routing.local
      .flatMap((a) => this.modelInfo(a) ?? [])
      .find((m) => m.tier === 'local' && m.available);
    if (local) return local;
    if (routing.mode === 'local-only') return undefined;
    const spend = this.ledger.spend();
    const b = routing.budget;
    if (
      (b.dailyUsd && spend.todayUsd >= b.dailyUsd) ||
      (b.monthlyUsd && spend.monthUsd >= b.monthlyUsd)
    )
      return undefined;
    return routing.remote
      .flatMap((a) => this.modelInfo(a) ?? [])
      .find((m) => m.available && m.contextWindow > Math.min(tokens, 16_000));
  }

  private async summarize(
    s: LiveSession,
    provider: Provider,
    model: ModelInfo,
    previous: string | undefined,
    chunk: string,
    signal: AbortSignal,
  ): Promise<string> {
    let done: Extract<ChatEvent, { type: 'done' }> | undefined;
    for await (const ev of provider.stream({
      model: model.ref.model,
      system: SUMMARIZER_PROMPT,
      messages: [
        { role: 'user', parts: [{ type: 'text', text: summaryRequest(previous, chunk) }] },
      ],
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
    const text = done.parts
      .flatMap((p) => (p.type === 'text' ? [p.text] : []))
      .join('')
      .trim();
    if (!text) throw new Error(`${model.alias} returned an empty summary`);
    return text;
  }

  private async runTools(
    s: LiveSession,
    tools: Tool[],
    catalog: ToolContext['agentCatalog'],
    calls: { id: string; name: string; input: unknown }[],
    turnId: string,
    signal: AbortSignal,
  ): Promise<ToolResultPart[]> {
    const ctx: ToolContext = {
      workspaceRoot: this.options.workspaceRoot,
      sessionId: s.header.id,
      signal,
      agentCatalog: catalog,
      runSubagent: (agent, prompt, description, options) =>
        this.runSubagent(s, agent, prompt, description, signal, options),
    };
    const runOne = async (call: (typeof calls)[number]): Promise<ToolResultPart> => {
      const tool = tools.find((t) => t.name === call.name);
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
      const permission = await this.checkPermission(s, tool, parsed.data, ctx, signal);
      if (!permission.allowed) {
        output =
          permission.error ??
          'The user denied this action. Do not retry it; ask the user how to proceed.';
        isError = true;
      } else {
        try {
          output = await tool.run(parsed.data, ctx);
        } catch (err) {
          output = (err as Error).message;
          isError = true;
        }
      }
      s.signals.recordToolResult(!isError);
      this.emit({
        type: 'tool.completed',
        ...this.scope(s),
        turnId,
        callId: call.id,
        name: call.name,
        output,
        isError,
      });
      return {
        type: 'tool_result',
        callId: call.id,
        content: output,
        ...(isError ? { isError } : {}),
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
    options: { background?: boolean } = {},
  ): Promise<SubagentResult> {
    const depth = parent.depth + 1;
    let slots = this.subagentSlots.get(depth);
    if (!slots) {
      // One pool per depth: a parent holding a slot never waits on its own children.
      slots = new Semaphore(this.options.config.subagents.maxConcurrent);
      this.subagentSlots.set(depth, slots);
    }
    const child = this.createSession({ agent, title: description, parentId: parent.header.id });
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
        const result = await this.runTurn(child.id, prompt, 'auto', undefined, runSignal);
        const ok = result.stopReason === 'end_turn';
        this.emit({
          type: 'subagent.completed',
          ...this.scope(parent),
          childSessionId: child.id,
          agent,
          ok,
          ...(background ? { background } : {}),
        });
        return {
          ok,
          text: ok
            ? result.text
            : `${result.stopReason}: ${this.sessions.get(child.id)?.lastError ?? result.text}`,
          sessionId: child.id,
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
    };
    this.sessions.set(sessionId, live);
    return live;
  }

  private append(s: LiveSession, message: Message): void {
    s.messages.push(message);
    s.updatedAt = this.now().toISOString();
    this.store.append(s.header.id, message);
  }

  private recordUsage(
    s: LiveSession,
    tier: Tier,
    model: ModelRef,
    usage: Usage,
    meta: { rule: string; agent: string },
  ): void {
    this.ledger.record(s.header.id, tier, model, usage, meta);
    if (tier === 'remote') this.checkCache(s, model, usage);
    const total = this.ledger.sessionCost(s.header.id);
    this.emit({
      type: 'usage.updated',
      ...this.scope(s),
      usage: total.usage,
      costUsd: total.costUsd,
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
      ...(this.sessions.get(header.id)?.controller ? { running: true } : {}),
    };
  }

  /** Whether any session has a turn in progress (daemons stay up while busy). */
  busy(): boolean {
    for (const s of this.sessions.values()) if (s.controller || s.background.size) return true;
    return false;
  }

  private systemPrompt(agent: AgentDefinition): string {
    const sections = [
      agent.prompt,
      `# Environment\nWorkspace root: ${this.options.workspaceRoot}\nPlatform: ${process.platform}\nShell for the bash tool: ${currentShell().name}\nFile paths in tool calls are relative to the workspace root.`,
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
    for (const alias of routing.local) {
      const local = this.modelInfo(alias);
      if (!local || local.tier !== 'local' || !local.available) continue;
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
