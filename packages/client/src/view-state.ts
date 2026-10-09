/**
 * The view model's shape: what a session looks like to a UI, and the small
 * queries both clients make of it. The reducer that builds it is in view.ts.
 */
import type {
  ModelRef,
  PermissionMode,
  QueuedPrompt,
  ReviewIssue,
  SessionRoles,
  ShellInfo,
  Tier,
} from '@switchback/protocol';

export type ViewItem =
  | { kind: 'user'; id: string; text: string }
  /** An image the user sent; `src` is a data URL for clients that can show it. */
  | { kind: 'image'; id: string; name: string; src?: string }
  | { kind: 'assistant'; id: string; text: string; reasoning: string }
  | {
      kind: 'route';
      id: string;
      tier: Tier;
      model: ModelRef;
      rule: string;
      reason: string;
      /** How fast the call it started answered, once it has (`call.stats`). */
      tokensPerSecond?: number;
    }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      status: 'running' | 'ok' | 'error';
      output?: string;
      /** The result carried private content (`privacy.localOnlyPaths`). */
      private?: string;
      /** The call never ran: the user, a rule, or a hook refused it. */
      denied?: boolean;
      /** What an edit or write changed (unified diff). */
      diff?: string;
    }
  | {
      kind: 'subagent';
      id: string;
      agent: string;
      task: string;
      status: 'running' | 'ok' | 'error';
      tier?: Tier;
      activity?: string;
      toolCalls: number;
      /** The parent didn't wait; the report arrives later as a message. */
      background?: boolean;
    }
  | {
      kind: 'review';
      id: string;
      verdict: 'approve' | 'revise' | 'skipped';
      summary: string;
      issues: ReviewIssue[];
      model?: ModelRef;
      round: number;
    }
  | { kind: 'error'; id: string; message: string }
  /** Client-local notices (slash command output); never produced by the engine. */
  | { kind: 'info'; id: string; text: string };

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'done';
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'done']);

/** A `todo` call's items, or undefined when they aren't a valid list (the engine rejects those). */
export function todoItems(input: unknown): TodoItem[] | undefined {
  const items = (input as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return undefined;
  const ok = items.every(
    (i) =>
      typeof i?.text === 'string' && TODO_STATUSES.has((i as { status?: string }).status ?? ''),
  );
  return ok ? (items as TodoItem[]) : undefined;
}

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  /** Unified diff for edits. */
  preview?: string;
  /** What "always" grants, as rules; absent when an ask rule asks every time. */
  rules?: string[];
  /** The ask rule behind this prompt, when there is one. */
  askRule?: string;
  /** Another reason it asks (outside the workspace, Switchback's own configuration). */
  reason?: string;
  /** A plan to approve (plan mode). */
  plan?: string;
}

export interface PendingEscalation {
  requestId: string;
  reason: string;
  target: ModelRef;
  estimatedCostUsd?: number;
}

export interface ViewState {
  sessionId: string;
  items: ViewItem[];
  running: boolean;
  permissions: PendingPermission[];
  escalations: PendingEscalation[];
  costUsd: number;
  /** Saved versus running this session all-remote (this session only, not its subagents). */
  savingsUsd: number;
  lastTier?: Tier;
  /** How full the last call's context was, when the engine knew the window. */
  context?: { tokens: number; window: number };
  /** The last call's speed, for status lines. */
  speed?: { model: string; tokensPerSecond: number };
  /** Where the last call ran on the escalation ladder (`step` 0 is the start model). */
  ladder?: { step: number; steps: number; model: string; stickyTurns?: number };
  /** The session's roles, once they're known (`session.roles`) or changed. */
  roles?: SessionRoles;
  /** Why the session is pinned local for privacy; set once and never cleared. */
  private?: string;
  /** The permission mode (top-level sessions). */
  mode?: PermissionMode;
  /** Background shells started by this session or its subagents, by ID. */
  shells?: Record<string, ShellInfo>;
  /** Prompts sent during the running turn, waiting for its next step. */
  queue?: QueuedPrompt[];
  /** The model's latest checklist (its `todo` tool), if it keeps one. */
  todos?: TodoItem[];
  /** Each subagent's own view, keyed by child session ID (nested for deeper subagents). */
  children: Record<string, ViewState>;
}

export function initialView(sessionId: string): ViewState {
  return {
    sessionId,
    items: [],
    running: false,
    permissions: [],
    escalations: [],
    costUsd: 0,
    savingsUsd: 0,
    children: {},
  };
}

/** Whether `sessionId` is this session or any of its descendants. */
export function owns(state: ViewState, sessionId: string): boolean {
  if (state.sessionId === sessionId) return true;
  return Object.values(state.children).some((c) => owns(c, sessionId));
}

/** The agent name of a descendant session, from its parent's subagent row. */
export function agentOf(state: ViewState, sessionId: string): string | undefined {
  for (const it of state.items) if (it.kind === 'subagent' && it.id === sessionId) return it.agent;
  for (const c of Object.values(state.children)) {
    const found = agentOf(c, sessionId);
    if (found) return found;
  }
  return undefined;
}

/** A descendant's view (drill-down), or undefined if it isn't part of this tree. */
export function childView(state: ViewState, sessionId: string): ViewState | undefined {
  if (state.sessionId === sessionId) return state;
  for (const c of Object.values(state.children)) {
    const found = childView(c, sessionId);
    if (found) return found;
  }
  return undefined;
}
