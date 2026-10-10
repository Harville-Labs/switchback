/**
 * Switchback as an Agent Client Protocol agent, for editors that speak ACP
 * (Zed, JetBrains, Neovim plugins, ...). It's a thin client like the TUI:
 * every session lives in a Switchback engine reached through
 * @switchback/client, and this bridge only translates. An ACP session ID is
 * the Switchback session ID, so a session started in an editor can be
 * resumed in the TUI and the other way round.
 */
import * as acp from '@agentclientprotocol/sdk';
import { estimateLabel, permissionWhy, type SwitchbackClient } from '@switchback/client';
import { type EngineEvent, isSessionEvent, type PermissionDecision } from '@switchback/protocol';
import {
  isMode,
  modeState,
  planOf,
  promptOf,
  replay,
  stopReasonOf,
  toolCallCompleted,
  toolCallStarted,
  toolCallTitle,
  toolKind,
} from './translate.ts';

export interface AcpBridgeDeps {
  /** An engine for this workspace (an absolute path): the shared daemon, or a private one. */
  connect(cwd: string): Promise<SwitchbackClient>;
  version: string;
}

interface Session {
  cwd: string;
  engine: SwitchbackClient;
  /** The model the last call went to, to say when routing moves. */
  model?: string;
  /** Tool calls started and not yet finished, by call ID: their tool names. */
  running: Map<string, string>;
}

interface Turn {
  sessionId: string;
  resolve(r: acp.PromptResponse): void;
  reject(e: unknown): void;
  /** The last error the engine reported in this turn. */
  error?: string;
}

const ALLOW_ONCE = 'allow_once';
const ALLOW_ALWAYS = 'allow_always';
const REJECT = 'reject_once';

export class AcpBridge {
  private readonly engines = new Map<string, Promise<SwitchbackClient>>();
  private readonly sessions = new Map<string, Session>();
  /** Subagent sessions to their parents, so their prompts reach the editor's session. */
  private readonly parents = new Map<string, string>();
  private readonly turns = new Map<string, Turn>();
  /** Permission and escalation prompts open in the editor, by engine request ID. */
  private readonly asks = new Map<string, AbortController>();
  private editor: acp.AgentContext | undefined;

  constructor(private readonly deps: AcpBridgeDeps) {}

  /** The ACP agent, ready to connect to a stream (stdio) or a client app (tests). */
  app(): acp.AgentApp {
    return acp
      .agent({ name: 'switchback' })
      .onConnect((connection) => {
        this.editor = connection.client;
      })
      .onRequest('initialize', () => this.initialize())
      .onRequest('authenticate', () => ({}))
      .onRequest('session/new', ({ params }) => this.newSession(params))
      .onRequest('session/load', ({ params }) => this.loadSession(params))
      .onRequest('session/list', ({ params }) => this.listSessions(params))
      .onRequest('session/prompt', ({ params }) => this.prompt(params))
      .onRequest('session/set_mode', ({ params }) => this.setMode(params))
      .onNotification('session/cancel', ({ params }) => this.cancel(params.sessionId));
  }

  initialize(): acp.InitializeResponse {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'switchback', title: 'Switchback', version: this.deps.version },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {} },
      },
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const engine = await this.engine(params.cwd);
    const s = await engine.request('session.create', {});
    this.track(s.id, params.cwd, engine);
    return { sessionId: s.id, modes: modeState(s.permissionMode) };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    const engine = await this.engine(params.cwd);
    const { session, messages } = await engine.request('session.get', {
      sessionId: params.sessionId,
    });
    this.track(session.id, params.cwd, engine);
    for (const update of replay(messages, params.cwd)) await this.update(session.id, update);
    return { modes: modeState(session.permissionMode) };
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const cwds = params.cwd ? [params.cwd] : [...this.engines.keys()];
    const sessions: acp.SessionInfo[] = [];
    for (const cwd of cwds) {
      const engine = await this.engine(cwd);
      for (const s of await engine.request('session.list', {}))
        sessions.push({ sessionId: s.id, cwd, title: s.title || null, updatedAt: s.updatedAt });
    }
    return { sessions };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const s = this.session(params.sessionId);
    const { text, attachments } = promptOf(params.prompt, s.cwd);
    const done = new Promise<acp.PromptResponse>((resolve, reject) => {
      // Registered before the request: a short turn can finish before it returns.
      this.turns.set(`pending:${params.sessionId}`, {
        sessionId: params.sessionId,
        resolve,
        reject,
      });
    });
    const { turnId } = await s.engine.request('session.prompt', {
      sessionId: params.sessionId,
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    this.claim(params.sessionId, turnId);
    return done;
  }

  async setMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    if (!isMode(params.modeId))
      throw acp.RequestError.invalidParams(undefined, `unknown mode "${params.modeId}"`);
    await this.session(params.sessionId).engine.request('session.setMode', {
      sessionId: params.sessionId,
      mode: params.modeId,
    });
    return {};
  }

  async cancel(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.engine.request('session.cancel', { sessionId });
  }

  // ---------------------------------------------------------------------------

  private engine(cwd: string): Promise<SwitchbackClient> {
    let engine = this.engines.get(cwd);
    if (!engine) {
      engine = this.deps.connect(cwd).then((client) => {
        client.on((e) => void this.onEvent(e));
        return client;
      });
      this.engines.set(cwd, engine);
    }
    return engine;
  }

  private track(sessionId: string, cwd: string, engine: SwitchbackClient): void {
    if (!this.sessions.has(sessionId))
      this.sessions.set(sessionId, { cwd, engine, running: new Map() });
  }

  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s)
      throw acp.RequestError.invalidParams(
        undefined,
        `no session "${sessionId}" on this connection; create it with session/new or load it with session/load`,
      );
    return s;
  }

  /** Give the waiting prompt its turn ID, unless the turn already finished. */
  private claim(sessionId: string, turnId: string): void {
    const waiting = this.turns.get(`pending:${sessionId}`);
    if (!waiting) return;
    this.turns.delete(`pending:${sessionId}`);
    this.turns.set(turnId, waiting);
  }

  /** The turn an event belongs to: claimed, or the session's prompt still waiting for its ID. */
  private turn(sessionId: string, turnId: string): Turn | undefined {
    return this.turns.get(turnId) ?? this.turns.get(`pending:${sessionId}`);
  }

  /** The editor's session an engine session reports to: itself, or its top-level parent. */
  private top(sessionId: string): string | undefined {
    let id = sessionId;
    for (let parent = this.parents.get(id); parent; parent = this.parents.get(id)) id = parent;
    return this.sessions.has(id) ? id : undefined;
  }

  private update(sessionId: string, update: acp.SessionNotification['update']): Promise<void> {
    return this.editor?.notify('session/update', { sessionId, update }) ?? Promise.resolve();
  }

  private async onEvent(e: EngineEvent): Promise<void> {
    if (!isSessionEvent(e)) return;
    if (e.type === 'subagent.started') this.parents.set(e.childSessionId, e.sessionId);
    const sessionId = this.top(e.sessionId);
    if (!sessionId) return;
    // Prompts from subagents go to the editor; everything else they do stays in their tool call.
    if (e.type === 'permission.requested') return this.askPermission(sessionId, e);
    if (e.type === 'escalation.requested') return this.askEscalation(sessionId, e);
    if (e.type === 'permission.resolved' || e.type === 'escalation.resolved') {
      // Answered here or in another client of a shared engine: close the editor's prompt.
      this.asks.get(e.requestId)?.abort();
      this.asks.delete(e.requestId);
      return;
    }
    if (e.sessionId !== sessionId) return;
    const s = this.session(sessionId);
    switch (e.type) {
      case 'text.delta':
        return this.update(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: e.text },
        });
      case 'reasoning.delta':
        return this.update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: e.text },
        });
      case 'route.decided': {
        // Which model answers, and why, is never hidden (AGENTS.md invariant 3).
        const model = `${e.model.provider}/${e.model.model}`;
        if (model === s.model) return;
        s.model = model;
        return this.update(sessionId, {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: `→ ${e.tier} ${model}: ${e.reason}\n` },
        });
      }
      case 'tool.started': {
        s.running.set(e.callId, e.name);
        await this.update(sessionId, toolCallStarted(e, s.cwd));
        const plan = planOf(e.name, e.input);
        return plan ? this.update(sessionId, plan) : undefined;
      }
      case 'tool.completed':
        s.running.delete(e.callId);
        return this.update(sessionId, toolCallCompleted(e));
      case 'mode.changed':
        return this.update(sessionId, {
          sessionUpdate: 'current_mode_update',
          currentModeId: e.mode,
        });
      case 'error': {
        const turn = e.turnId ? this.turn(sessionId, e.turnId) : undefined;
        if (turn) turn.error = e.message;
        return;
      }
      case 'turn.completed':
        return this.finish(sessionId, e.turnId, e.stopReason);
    }
  }

  private finish(
    sessionId: string,
    turnId: string,
    reason: Extract<EngineEvent, { type: 'turn.completed' }>['stopReason'],
  ): void {
    const turn = this.turn(sessionId, turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    this.turns.delete(`pending:${sessionId}`);
    const stopReason = stopReasonOf(reason);
    if (stopReason) turn.resolve({ stopReason });
    else turn.reject(acp.RequestError.internalError(undefined, turn.error ?? 'the turn failed'));
  }

  /** The tool call a permission prompt is about: the latest one of that tool still running. */
  private callFor(s: Session, tool: string): string | undefined {
    return [...s.running].reverse().find(([, name]) => name === tool)?.[0];
  }

  private async askPermission(
    sessionId: string,
    e: Extract<EngineEvent, { type: 'permission.requested' }>,
  ): Promise<void> {
    const s = this.session(sessionId);
    const plan = e.plan;
    const shown = plan ?? (e.preview ? `\`\`\`diff\n${e.preview}\n\`\`\`` : undefined);
    const details = [permissionWhy(e), shown].filter(Boolean).join('\n\n') || undefined;
    // A plan's "always" is approving it and accepting edits from then on (permissions/gate.ts).
    const always = plan
      ? 'Approve and accept edits'
      : e.rules?.length
        ? `Always allow ${e.rules.join(', ')}`
        : undefined;
    const options: acp.PermissionOption[] = [
      { optionId: ALLOW_ONCE, name: plan ? 'Approve plan' : 'Allow', kind: 'allow_once' },
      ...(always ? [{ optionId: ALLOW_ALWAYS, name: always, kind: 'allow_always' as const }] : []),
      { optionId: REJECT, name: plan ? 'Keep planning' : 'Deny', kind: 'reject_once' },
    ];
    const chosen = await this.ask(e.requestId, {
      sessionId,
      toolCall: {
        toolCallId: this.callFor(s, e.tool) ?? e.requestId,
        title: e.summary || toolCallTitle(e.tool, e.input),
        kind: toolKind(e.tool),
        rawInput: e.input,
        ...(details
          ? { content: [{ type: 'content', content: { type: 'text', text: details } }] }
          : {}),
      },
      options,
    });
    if (chosen === undefined) return;
    const decision: PermissionDecision =
      chosen === ALLOW_ONCE ? 'allow_once' : chosen === ALLOW_ALWAYS ? 'allow_always' : 'deny';
    await s.engine.request('permission.respond', { requestId: e.requestId, decision });
  }

  private async askEscalation(
    sessionId: string,
    e: Extract<EngineEvent, { type: 'escalation.requested' }>,
  ): Promise<void> {
    const s = this.session(sessionId);
    const target = `${e.target.provider}/${e.target.model}`;
    const chosen = await this.ask(e.requestId, {
      sessionId,
      toolCall: {
        toolCallId: e.requestId,
        title: `Escalate to ${target}${e.estimatedCostUsd === undefined ? '' : ` (${estimateLabel(e.estimatedCostUsd)})`}`,
        kind: 'other',
        content: [{ type: 'content', content: { type: 'text', text: e.reason } }],
      },
      options: [
        { optionId: ALLOW_ONCE, name: `Use ${target}`, kind: 'allow_once' },
        { optionId: REJECT, name: 'Stay on the current model', kind: 'reject_once' },
      ],
    });
    if (chosen === undefined) return;
    await s.engine.request('escalation.respond', {
      requestId: e.requestId,
      approve: chosen === ALLOW_ONCE,
    });
  }

  /**
   * Ask the editor and return the chosen option. Undefined when the prompt
   * was answered elsewhere (another client of a shared engine). The editor
   * cancelling the prompt counts as refusing, as the spec asks.
   */
  private async ask(
    requestId: string,
    params: acp.RequestPermissionRequest,
  ): Promise<string | undefined> {
    if (!this.editor) return REJECT;
    const abort = new AbortController();
    this.asks.set(requestId, abort);
    try {
      const { outcome } = await this.editor.request('session/request_permission', params, {
        cancellationSignal: abort.signal,
      });
      if (abort.signal.aborted) return undefined;
      return outcome.outcome === 'selected' ? outcome.optionId : REJECT;
    } catch (err) {
      if (abort.signal.aborted) return undefined;
      // The editor failed to ask; refusing is the safe answer.
      console.error(`switchback acp: permission request failed: ${(err as Error).message}`);
      return REJECT;
    } finally {
      this.asks.delete(requestId);
    }
  }
}
