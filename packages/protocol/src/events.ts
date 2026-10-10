/**
 * Engine -> client events: JSON-RPC notifications with method "event". Every
 * client folds them into its view through `reduce()` in @switchback/client.
 */
import type {
  OrgInfo,
  PermissionDecision,
  PermissionMode,
  QueuedPrompt,
  ReviewIssue,
  SessionRoles,
  ShellInfo,
} from './methods.ts';
import type { SetupNote, SetupOutcome, SetupQuestion } from './setup.ts';
import type { ModelRef, StopReason, Tier, Usage } from './transcript.ts';
import type { WorktreeOutcome, WorktreeStart } from './worktrees.ts';

interface SessionScoped {
  sessionId: string;
  /** Set when the session is a subagent; lets clients render a tree. */
  parentSessionId?: string;
}

export type EngineEvent =
  | ({ type: 'turn.started'; turnId: string } & SessionScoped)
  | ({
      type: 'route.decided';
      turnId: string;
      tier: Tier;
      model: ModelRef;
      rule: string;
      reason: string;
      /** Prompt size the decision was based on (exact when the local server counted it). */
      inputTokens?: number;
      /** The chosen model's context window, so clients can show how full it is. */
      contextWindow?: number;
      /** Where the model is on the escalation ladder: 0 is `start`, `steps` the top. */
      step?: number;
      steps?: number;
      /** Calls left before routing returns to `start` after an escalation. */
      stickyTurns?: number;
    } & SessionScoped)
  | ({ type: 'roles.updated'; roles: SessionRoles } & SessionScoped)
  | ({ type: 'mode.changed'; mode: PermissionMode } & SessionScoped)
  /** The session's queued prompts changed. */
  | ({ type: 'queue.updated'; queued: QueuedPrompt[] } & SessionScoped)
  /** A queued prompt reached the model; clients show it as the user's message now. */
  | ({ type: 'queue.delivered'; turnId: string; prompt: QueuedPrompt } & SessionScoped)
  /** A background shell started, exited, or was stopped. */
  | ({ type: 'shell.updated'; shell: ShellInfo } & SessionScoped)
  | ({ type: 'text.delta'; turnId: string; text: string } & SessionScoped)
  | ({ type: 'reasoning.delta'; turnId: string; text: string } & SessionScoped)
  | ({
      type: 'tool.started';
      turnId: string;
      callId: string;
      name: string;
      input: unknown;
    } & SessionScoped)
  | ({
      type: 'tool.completed';
      turnId: string;
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      /** Set when the call didn't run because the permission policy, a hook, or the user refused it. */
      denied?: boolean;
      /** Set when the result carries private content, so the session now stays local. */
      private?: string;
      /** A unified diff of what an edit or write changed, for display only (the model never sees it). */
      diff?: string;
    } & SessionScoped)
  | ({
      type: 'permission.requested';
      requestId: string;
      tool: string;
      summary: string;
      input: unknown;
      /** Unified diff of what the call would change, for edits (may be truncated). */
      preview?: string;
      /** The complete proposed file, so editors can show a real diff. */
      proposed?: { path: string; content: string };
      /** What `allow_always` grants, as permission rules (e.g. `bash(git status:*)`). */
      rules?: string[];
      /** For `exit_plan_mode`: the plan the user is asked to approve (Markdown). */
      plan?: string;
      /** Why the user is asked even though a mode or level would allow it: an ask rule. */
      askRule?: string;
      /**
       * Another reason the user is asked: `outside the workspace`, `Switchback's
       * own configuration`, `running outside the OS sandbox`, or a hook's.
       */
      reason?: string;
    } & SessionScoped)
  | ({
      type: 'permission.resolved';
      requestId: string;
      decision: PermissionDecision;
    } & SessionScoped)
  | ({ type: 'escalation.resolved'; requestId: string; approved: boolean } & SessionScoped)
  | ({
      type: 'context.compacted';
      /** Messages now represented by the summary. */
      messages: number;
      tokensBefore: number;
      tokensAfter: number;
    } & SessionScoped)
  | ({
      type: 'escalation.requested';
      requestId: string;
      reason: string;
      target: ModelRef;
      /**
       * Rough cost of approving: this call plus the sticky follow-ups, from
       * the prompt size and this session's typical output. Absent when the
       * target model has no known price.
       */
      estimatedCostUsd?: number;
    } & SessionScoped)
  | ({
      type: 'subagent.started';
      childSessionId: string;
      agent: string;
      task: string;
      /** Started with `background: true`: the parent didn't wait for it. */
      background?: boolean;
      /** Set when it works in its own git worktree. */
      worktree?: WorktreeStart;
    } & SessionScoped)
  | ({
      type: 'subagent.completed';
      childSessionId: string;
      agent: string;
      ok: boolean;
      background?: boolean;
      /** What it left on its branch, when it worked in a worktree. */
      worktree?: WorktreeOutcome;
    } & SessionScoped)
  | ({
      type: 'review.completed';
      turnId: string;
      /** `skipped`: review was on but couldn't run; `summary` says why. */
      verdict: 'approve' | 'revise' | 'skipped';
      summary: string;
      issues: ReviewIssue[];
      /** The reviewer; absent when skipped before one was chosen. */
      model?: ModelRef;
      /** 1 for the first review of a turn; a revise leads to another round, up to `review.maxRounds`. */
      round: number;
    } & SessionScoped)
  | ({
      type: 'secrets.redacted';
      /** Secrets replaced in this request, e.g. `GITHUB_TOKEN`; counts repeats. */
      kinds: string[];
      model: ModelRef;
    } & SessionScoped)
  | ({
      type: 'usage.updated';
      usage: Usage;
      costUsd: number;
      /** Saved so far in this session versus running it all on the reference remote model. */
      savingsUsd?: number;
      tier: Tier;
    } & SessionScoped)
  /** A model call finished: how fast the model answered. */
  | ({
      type: 'call.stats';
      turnId: string;
      model: ModelRef;
      tier: Tier;
      outputTokens: number;
      /**
       * Output tokens per second, from the first streamed token to the last
       * (the whole call when nothing streamed). Absent for very short answers,
       * where it would mostly measure latency.
       */
      tokensPerSecond?: number;
      /** Milliseconds until the first token streamed. */
      firstTokenMs?: number;
    } & SessionScoped)
  | ({ type: 'turn.completed'; turnId: string; stopReason: StopReason } & SessionScoped)
  | ({ type: 'error'; turnId?: string; message: string } & SessionScoped)
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  /** Configuration changed while running (e.g. an organization policy update). */
  | { type: 'config.updated'; org?: OrgInfo; notes: string[] }
  /** Setup (setup.start) asks a question; answer with `setup.answer`. */
  | { type: 'setup.ask'; setupId: string; requestId: string; question: SetupQuestion }
  | { type: 'setup.note'; setupId: string; note: SetupNote }
  | ({ type: 'setup.finished'; setupId: string } & SetupOutcome);

export type EngineEventType = EngineEvent['type'];

/** Events about one session (and its subagents): everything but logs, config changes, and setup. */
export type SessionEvent = Extract<EngineEvent, { sessionId: string }>;

export function isSessionEvent(e: EngineEvent): e is SessionEvent {
  return 'sessionId' in e;
}
