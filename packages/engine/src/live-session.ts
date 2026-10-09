/**
 * A session as the engine holds it in memory, and the pieces of the engine its
 * collaborators (tools, review, compaction, subagents) need. Each collaborator
 * receives an `EngineHost` instead of reaching into the engine.
 */
import type {
  Attachment,
  EngineEvent,
  Message,
  ModelRef,
  PermissionMode,
  QueuedPrompt,
  SessionRoles,
  StopReason,
  TextPart,
  Tier,
  Usage,
} from '@switchback/protocol';
import type { SignalTracker } from '@switchback/router';
import type { SwitchbackConfig } from './config.ts';
import type { InstructionHashes } from './instructions-live.ts';
import type { OrgStatus } from './org/policy.ts';
import type { PrivatePathMatcher } from './privacy.ts';
import type { SessionHeader } from './store.ts';

export interface LiveSession {
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
  /** Each coding agent CLI model's own session (by alias), to resume on the session's next turn there. */
  agentSessions?: Record<string, string>;
  /** How much of the transcript each CLI model has seen (a message count), so it's told only what's new. */
  agentSeen?: Record<string, number>;
  /** The user asked to escalate (`session.escalate`): the next model call climbs one step. */
  escalateNow?: boolean;
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
  /** Top-level sessions: the permission mode; subagents follow their top-level session's. */
  mode?: PermissionMode;
  /** The mode the model was last told about (plan mode reminders). */
  toldMode?: PermissionMode;
  /** The AGENTS.md hashes the model was last told about; worked out from the transcript when unset. */
  toldInstructions?: InstructionHashes;
  /** The running turn, so prompts sent meanwhile can join it or interrupt it. */
  turn?: { id: string; done: Promise<unknown> };
  /** Prompts sent during the running turn, delivered at its next step. */
  queue?: (QueuedPrompt & { attachments: Attachment[] })[];
  /** SessionStart hooks have run for this session in this engine. */
  hooksStarted?: boolean;
}

export interface TurnResult {
  stopReason: StopReason;
  text: string;
}

/** The session fields every session-scoped event carries. */
export function scope(s: LiveSession): { sessionId: string; parentSessionId?: string } {
  return {
    sessionId: s.header.id,
    ...(s.header.parentId ? { parentSessionId: s.header.parentId } : {}),
  };
}

/** What the engine lends its collaborators. */
export interface EngineHost {
  config(): SwitchbackConfig;
  org(): OrgStatus | undefined;
  emit(event: EngineEvent): void;
  notify(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  append(s: LiveSession, message: Message): void;
  rolesOf(s: LiveSession): SessionRoles;
  /** Why a remote model may not be called for this session now; undefined when it may. */
  remoteBlocked(s?: LiveSession): string | undefined;
  recordUsage(
    s: LiveSession,
    tier: Tier,
    model: ModelRef,
    usage: Usage,
    meta: { rule: string; agent: string; costUsd?: number; decodeMs?: number },
  ): void;
  /** Where a session's tools operate: its worktree, or the workspace. */
  rootOf(s: LiveSession): string;
  /** The top-level session of a subagent (or the session itself). */
  top(s: LiveSession): LiveSession;
  session(id: string): LiveSession | undefined;
  /** Matcher for `privacy.localOnlyPaths`; undefined when none are set. */
  privatePaths(): PrivatePathMatcher | undefined;
}
