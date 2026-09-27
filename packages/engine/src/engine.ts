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
  type Message,
  type ModelRef,
  type PermissionDecision,
  PROTOCOL_VERSION,
  type RoutePreference,
  RpcError,
  type SessionGetResult,
  type SessionSummary,
  type StopReason,
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
import { estimateTokens, type ModelInfo, Router, SignalTracker } from '@harness/router';
import { type AgentDefinition, loadAgents, summarize } from './agents.ts';
import type { HarnessConfig } from './config.ts';
import { estimateEscalationCost } from './estimate.ts';
import { type LedgerEntry, UsageLedger } from './ledger.ts';
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
  type Tool,
  type ToolContext,
  type ToolPreview,
  toolSpec,
  toolsFor,
} from './tools/index.ts';
import { currentShell } from './tools/shell.ts';

export const ENGINE_VERSION = '0.3.0';

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
  now?: () => Date;
}

interface LiveSession {
  header: SessionHeader;
  messages: Message[];
  updatedAt: string;
  signals: SignalTracker;
  depth: number;
  controller?: AbortController;
}

interface TurnResult {
  stopReason: StopReason;
  text: string;
}

const HEALTH_TTL_OK_MS = 30_000;
/** Assumed when neither config nor server says; small on purpose so we escalate rather than truncate. */
const UNKNOWN_LOCAL_CONTEXT = 8_192;
const UNKNOWN_REMOTE_CONTEXT = 200_000;
const HEALTH_TTL_FAIL_MS = 5_000;

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

  constructor(private readonly options: EngineOptions) {
    const { config } = options;
    for (const [id, pc] of Object.entries(config.providers)) {
      this.providers.set(id, options.providers?.get(id) ?? createProvider(id, pc));
      this.providerConfigs.set(id, JSON.stringify(pc));
    }
    for (const [id, p] of options.providers ?? []) this.providers.set(id, p);
    this.router = new Router(config.routing, (alias) => this.modelInfo(alias));
    const reference = config.models[config.routing.remote]?.model;
    this.ledger = new UsageLedger(options.ledgerFile, options.prices ?? {}, reference, options.now);
    this.store = options.store ?? new MemorySessionStore();
    this.agents = options.agents ?? loadAgents([]).agents;
    this.now = options.now ?? (() => new Date());
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
  ): Promise<TurnResult> {
    const session = typeof s === 'string' ? this.live(s) : s;
    if (session.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is busy');
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    session.controller = controller;
    if (!session.header.title) session.header.title = text.slice(0, 60);

    this.emit({ type: 'turn.started', ...this.scope(session), turnId });
    const attachments = [
      ...(await expandAttachments(extra, this.options.workspaceRoot).catch(() => [])),
      ...(await expandMentions(text, this.options.workspaceRoot).catch(() => [])),
    ];
    this.append(session, { role: 'user', parts: [{ type: 'text', text }, ...attachments] });
    session.signals.startUserTurn();

    let stopReason: StopReason = 'end_turn';
    try {
      stopReason = await this.loop(session, route, turnId, controller.signal);
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

  cancel(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s?.controller) return false;
    s.controller.abort();
    return true;
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
    this.options.config = next.config;
    if (next.org) this.options.org = next.org;
    this.router = new Router(next.config.routing, (alias) => this.modelInfo(alias));
    this.ledger.setPricing(
      next.prices ?? {},
      next.config.models[next.config.routing.remote]?.model,
    );
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
    for (const s of this.sessions.values()) s.controller?.abort();
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
    const agent = this.agents.get(s.header.agent);
    if (!agent) throw new Error(`agent "${s.header.agent}" no longer exists`);
    const canDelegate = s.depth < this.options.config.subagents.maxDepth;
    const tools = toolsFor(agent.tools).filter((t) => t.name !== 'task' || canDelegate);
    const catalog = [...this.agents.values()]
      .filter((a) => a.name !== s.header.agent || s.depth === 0)
      .map((a) => ({ name: a.name, description: a.description }));
    const specs = tools.map((t) => toolSpec(t, { agentCatalog: catalog }));
    const specChars = JSON.stringify(specs).length;
    let escalationApproved = false;
    let forceLocal = false;
    let failures = 0;

    for (let step = 0; step < this.options.config.maxStepsPerTurn; step++) {
      if (signal.aborted) return 'cancelled';
      await this.refreshHealth(signal);

      const inputTokens = estimateTokens(s.header.system, s.messages, specChars);
      const decision = this.router.decide({
        preference: forceLocal ? 'local' : preference,
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
        this.emit({
          type: 'error',
          ...this.scope(s),
          turnId,
          message: `cannot route turn: ${decision.reason}`,
        });
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

      const { model, rule, reason, escalated } = decision;
      this.emit({
        type: 'route.decided',
        ...this.scope(s),
        turnId,
        tier: model.tier,
        model: model.ref,
        rule,
        reason,
      });
      const provider = this.providers.get(model.ref.provider);
      if (!provider) throw new Error(`provider "${model.ref.provider}" is not configured`);
      const modelConfig = this.options.config.models[model.alias];

      let done: Extract<ChatEvent, { type: 'done' }> | undefined;
      try {
        for await (const ev of provider.stream({
          model: model.ref.model,
          system: s.header.system,
          // Snapshot: providers must never observe later appends.
          messages: [...s.messages],
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
        if (retryable) this.health.set(provider.id, { ok: false, at: Date.now() });
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

      this.recordUsage(s, model.tier, model.ref, done.usage, { rule, agent: agent.name });
      s.signals.recordTurn(model.tier, escalated);
      escalationApproved = false;

      const toolCalls = done.parts.filter((p) => p.type === 'tool_call');
      const truncatedTools = done.stopReason === 'max_tokens' && toolCalls.length > 0;

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
      runSubagent: (agent, prompt, description) =>
        this.runSubagent(s, agent, prompt, description, signal),
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
  ) {
    const depth = parent.depth + 1;
    let slots = this.subagentSlots.get(depth);
    if (!slots) {
      // One pool per depth: a parent holding a slot never waits on its own children.
      slots = new Semaphore(this.options.config.subagents.maxConcurrent);
      this.subagentSlots.set(depth, slots);
    }
    await slots.acquire(signal);
    try {
      const child = this.createSession({ agent, title: description, parentId: parent.header.id });
      this.emit({
        type: 'subagent.started',
        ...this.scope(parent),
        childSessionId: child.id,
        agent,
        task: description,
      });
      const result = await this.runTurn(child.id, prompt, 'auto', undefined, signal);
      const ok = result.stopReason === 'end_turn';
      this.emit({
        type: 'subagent.completed',
        ...this.scope(parent),
        childSessionId: child.id,
        agent,
        ok,
      });
      return {
        ok,
        text: ok ? result.text : `${result.stopReason}: ${result.text}`,
        sessionId: child.id,
      };
    } finally {
      slots.release();
    }
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
    const level = this.options.config.permissions[tool.permission];
    // deny first: an org can enforce it, and no session grant may override that.
    if (level === 'deny') return { allowed: false };
    if (level === 'allow' || this.alwaysAllowed.has(tool.permission)) return { allowed: true };
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
    if (decision === 'allow_always') this.alwaysAllowed.add(tool.permission);
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
    const total = this.ledger.sessionCost(s.header.id);
    this.emit({
      type: 'usage.updated',
      ...this.scope(s),
      usage: total.usage,
      costUsd: total.costUsd,
      tier,
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
    for (const s of this.sessions.values()) if (s.controller) return true;
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
    const now = Date.now();
    const used = new Set(Object.values(this.options.config.models).map((m) => m.provider));
    await Promise.all(
      [...used].map(async (id) => {
        const cached = this.health.get(id);
        if (cached && now - cached.at < (cached.ok ? HEALTH_TTL_OK_MS : HEALTH_TTL_FAIL_MS)) return;
        const provider = this.providers.get(id);
        if (!provider) return;
        const status = await provider.health(signal).catch(() => ({ ok: false }));
        this.health.set(id, { ok: status.ok, at: Date.now() });
      }),
    );
    await this.detectContextWindows();
  }
}
