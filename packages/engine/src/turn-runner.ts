/**
 * A user turn: append the prompt (with attachments, @-mentions, and any mode
 * reminder), run the agent loop, wait for background work when asked, and
 * review the edits.
 */
import {
  type Attachment,
  ErrorCode,
  type PermissionMode,
  type RoutePreference,
  RpcError,
  type SessionPromptParams,
  type SessionPromptResult,
  type StopReason,
  textOf,
} from '@switchback/protocol';
import type { AgentLoop } from './agent-loop.ts';
import type { TurnHooks } from './hooks/turn-hooks.ts';
import { type EngineHost, type LiveSession, scope, type TurnResult } from './live-session.ts';
import type { McpHub } from './mcp/hub.ts';
import { expandMcp } from './mcp/mentions.ts';
import { expandAttachments, expandMentions } from './mentions.ts';
import { modeReminder } from './permissions/modes.ts';
import type { ReviewRunner } from './review-runner.ts';

export interface TurnOptions {
  /** Finish background subagents before returning (headless runs and subagents). */
  waitForBackground?: boolean;
  /** Why the prompt itself is private (a subagent brief written from private context). */
  private?: string;
  /** Review of edits for this turn; overrides `review.mode`. */
  review?: boolean;
}

type PromptParams = Omit<SessionPromptParams, 'sessionId'>;

export interface TurnRunnerDeps {
  loop: AgentLoop;
  hooks: TurnHooks;
  reviews: ReviewRunner;
  mode(s: LiveSession): PermissionMode;
  /** A top-level turn with a prompt starts: the checkpoint it can be rewound to. */
  checkpoint(s: LiveSession, turnId: string, prompt: string): void;
  /** Connected MCP servers, for `/server:prompt` and `@server:uri`. */
  mcp(): McpHub | undefined;
}

export class TurnRunner {
  constructor(
    private readonly host: EngineHost,
    private readonly deps: TurnRunnerDeps,
  ) {}

  /** Start a turn and return immediately; progress arrives as events. */
  /**
   * `session.prompt`: start a turn, or, while one runs, queue the prompt for
   * its next step or interrupt it.
   */
  start(s: LiveSession, params: PromptParams): SessionPromptResult {
    const running = s.turn;
    if (!running) return { turnId: this.begin(s, params) };
    if (params.delivery === 'interrupt') {
      const turnId = `turn_${crypto.randomUUID().slice(0, 8)}`;
      // Only the turn: background subagents and queued prompts carry on.
      s.controller?.abort();
      // A cancelled turn doesn't start the queue, so the interrupting prompt goes first.
      void running.done.then(() => this.begin(s, params, turnId));
      return { turnId };
    }
    const id = `q_${crypto.randomUUID().slice(0, 8)}`;
    s.queue = [
      ...(s.queue ?? []),
      { id, text: params.text, attachments: params.attachments ?? [] },
    ];
    this.emitQueue(s);
    return { turnId: running.id, queued: id };
  }

  /** Withdraw a queued prompt. */
  dequeue(s: LiveSession, id: string): boolean {
    const before = s.queue?.length ?? 0;
    s.queue = s.queue?.filter((q) => q.id !== id);
    if ((s.queue?.length ?? 0) === before) return false;
    this.emitQueue(s);
    return true;
  }

  /** Drop every queued prompt (cancel). */
  /** Cancel the running turn and every background subagent the session started. */
  cancel(s: LiveSession): boolean {
    const hadWork = !!s.controller || s.background.size > 0;
    s.controller?.abort();
    s.bgController?.abort();
    s.bgController = undefined;
    s.inbox.length = 0;
    this.clearQueue(s);
    return hadWork;
  }

  clearQueue(s: LiveSession): void {
    if (!s.queue?.length) return;
    s.queue = [];
    this.emitQueue(s);
  }

  /** Hand queued prompts to the model; the agent loop calls this before each step. */
  async deliverQueued(s: LiveSession, turnId: string): Promise<void> {
    const queued = s.queue?.splice(0) ?? [];
    if (!queued.length) return;
    this.emitQueue(s);
    for (const q of queued) {
      const blocked = await this.appendPrompt(s, q.text, q.attachments, undefined);
      this.host.emit(
        blocked
          ? {
              type: 'error',
              ...scope(s),
              turnId,
              message: `A UserPromptSubmit hook blocked the queued prompt "${q.text}": ${blocked}`,
            }
          : { type: 'queue.delivered', ...scope(s), turnId, prompt: { id: q.id, text: q.text } },
      );
    }
  }

  private begin(
    s: LiveSession,
    params: PromptParams,
    turnId = `turn_${crypto.randomUUID().slice(0, 8)}`,
  ): string {
    void this.run(
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
      this.host.emit({ type: 'error', ...scope(s), turnId, message: (err as Error).message });
    });
    return turnId;
  }

  private emitQueue(s: LiveSession): void {
    this.host.emit({
      type: 'queue.updated',
      ...scope(s),
      queued: (s.queue ?? []).map(({ id, text }) => ({ id, text })),
    });
  }

  /** Run a full user turn to completion: the loop, waiting background work, and review. */
  async run(
    session: LiveSession,
    text: string,
    route: RoutePreference,
    turnId: string,
    parentSignal: AbortSignal | undefined,
    extra: Attachment[],
    options: TurnOptions,
  ): Promise<TurnResult> {
    if (session.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is busy');
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    session.controller = controller;
    let finished = () => {};
    session.turn = { id: turnId, done: new Promise<void>((r) => (finished = r)) };
    if (!session.header.title && text) session.header.title = text.slice(0, 60);

    this.host.emit({ type: 'turn.started', ...scope(session), turnId });
    // An empty prompt continues the session with whatever reports are waiting.
    if (text && session.depth === 0) this.deps.checkpoint(session, turnId, text);
    let stopReason: StopReason = 'end_turn';
    try {
      // Inside the try: a prompt that can't be built (an MCP prompt missing an
      // argument) fails the turn rather than leaving the session busy.
      const blocked = text
        ? await this.appendPrompt(session, text, extra, options.private)
        : undefined;
      session.signals.startUserTurn();
      if (session.depth === 0) session.turnEdits = new Map();
      // A blocked prompt never reaches the model; the turn ends the usual way.
      if (blocked) throw new Error(`A UserPromptSubmit hook blocked the prompt: ${blocked}`);
      stopReason = await this.deps.loop.run(session, route, turnId, controller.signal);
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
          stopReason = await this.deps.loop.run(session, route, turnId, controller.signal);
      }
      // A Stop hook can send the model back to work, a few times at most.
      for (let n = 0; stopReason === 'end_turn' && !controller.signal.aborted; n++) {
        const reason = await this.deps.hooks.keepGoing(session, n);
        if (!reason) break;
        this.host.append(session, {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: `A Stop hook says the work isn't done: ${reason}`,
              reminder: true,
            },
          ],
        });
        stopReason = await this.deps.loop.run(session, route, turnId, controller.signal);
      }
      const review = options.review ?? this.host.rolesOf(session).review.mode === 'auto';
      if (review && session.depth === 0 && stopReason === 'end_turn' && text)
        stopReason = await this.deps.reviews.reviewTurn(
          session,
          text,
          route,
          turnId,
          controller.signal,
        );
    } catch (err) {
      stopReason = controller.signal.aborted ? 'cancelled' : 'error';
      if (stopReason === 'error')
        this.host.emit({
          type: 'error',
          ...scope(session),
          turnId,
          message: (err as Error).message,
        });
    } finally {
      session.controller = undefined;
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
    this.host.emit({ type: 'turn.completed', ...scope(session), turnId, stopReason });
    session.turn = undefined;
    finished();
    // Prompts queued after the model's last step start the next turn.
    if (session.queue?.length && stopReason !== 'cancelled') this.begin(session, { text: '' });
    const last = session.messages.findLast((m) => m.role === 'assistant');
    return { stopReason, text: last ? textOf(last) : '' };
  }

  /**
   * The user's prompt, with attachments and @-mentioned files (marked private
   * where they are), and whatever hooks or the mode add for the model.
   * Returns why a hook blocked it, if one did; nothing is appended then.
   */
  private async appendPrompt(
    s: LiveSession,
    typed: string,
    extra: Attachment[],
    priv: string | undefined,
  ): Promise<string | undefined> {
    // Subagent briefs are the model's words; only the user's prompts reach MCP.
    const mcp =
      s.depth === 0 ? await expandMcp(typed, this.deps.mcp()) : { text: typed, parts: [] };
    const text = mcp.text;
    const hooked = await this.deps.hooks.beforePrompt(s, text);
    if (hooked.blocked) return hooked.blocked;
    const matches = this.host.privatePaths();
    const attachments = [
      ...mcp.parts,
      ...(await expandAttachments(extra, this.host.rootOf(s)).catch(() => [])),
      ...(await expandMentions(text, this.host.rootOf(s)).catch(() => [])),
    ].map((p) => {
      // A file attachment's path may carry a line range (`src/a.ts:3-9`).
      const path = p.attachment?.path.replace(/:\d+-\d+$/, '');
      return path && matches?.(path) ? { ...p, private: `attached ${path}` } : p;
    });
    const mode = this.deps.mode(s);
    const reminder = s.depth === 0 ? modeReminder(s.toldMode, mode) : undefined;
    s.toldMode = mode;
    const notes = [...hooked.context, ...(reminder ? [reminder] : [])];
    this.host.append(s, {
      role: 'user',
      parts: [
        { type: 'text', text, ...(priv ? { private: priv } : {}) },
        ...attachments,
        ...notes.map((note) => ({ type: 'text' as const, text: note, reminder: true as const })),
      ],
    });
    return undefined;
  }
}
