/**
 * The engine protocol: every request a client can make and every event the
 * engine can emit. TUI, VS Code, and headless `switchback run` all speak exactly
 * this surface. Adding a capability means adding it here first.
 */
import { z } from 'zod';
import type { Message, ModelRef, StopReason, Tier, Usage } from './transcript.ts';

export const PROTOCOL_VERSION = 1;

export const RoutePreference = z.enum(['auto', 'local', 'remote']);
export type RoutePreference = z.infer<typeof RoutePreference>;

/**
 * How a session treats tool calls the rules don't decide (docs/permissions.md):
 * `default` asks per the configured levels, `acceptEdits` allows edits in the
 * workspace, `plan` allows no edits until the user approves a plan, and
 * `bypassPermissions` allows everything but deny and ask rules.
 */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

// ---------------------------------------------------------------------------
// Client -> engine requests
// ---------------------------------------------------------------------------

export const InitializeParams = z.object({
  protocolVersion: z.number().int(),
  client: z.object({ name: z.string(), version: z.string() }),
  workspaceRoot: z.string(),
  /** Shared daemons require the token from their info file. */
  token: z.string().optional(),
});
export type InitializeParams = z.infer<typeof InitializeParams>;

/**
 * Ask a shared daemon to exit so a newer Switchback can take over the workspace.
 * Accepted before `initialize` (with the daemon's token), so it works across
 * protocol versions. The daemon refuses while other clients are attached or a
 * turn is running.
 */
export const DaemonRetireParams = z.object({ token: z.string() });
export type DaemonRetireParams = z.infer<typeof DaemonRetireParams>;

export interface DaemonRetireResult {
  retired: boolean;
  /** Why not, when `retired` is false. */
  reason?: string;
}

/**
 * Which models do what in a session (ADR 0015): where turns start, the
 * escalation ladder, the reviewers (`models: []` means the ladder), and the
 * default model for subagents. All by model alias.
 */
export interface SessionRoles {
  start: string[];
  escalate: string[][];
  review: { mode: 'off' | 'auto'; models: string[][] };
  subagents?: string;
  /** Roles this session changed; the rest follow the config. */
  overridden: ('start' | 'escalate' | 'review' | 'subagents')[];
}

export const SessionRolesParams = z.object({ sessionId: z.string() });
export type SessionRolesParams = z.infer<typeof SessionRolesParams>;

const Step = z.array(z.string().min(1)).min(1);
export const SessionSetRolesParams = z.object({
  sessionId: z.string(),
  start: Step.optional(),
  escalate: z.array(Step).optional(),
  review: z
    .object({ mode: z.enum(['off', 'auto']).optional(), models: z.array(Step).optional() })
    .optional(),
  /** `null` clears it: subagents route normally. */
  subagents: z.string().min(1).nullable().optional(),
  /** Also write the session's roles to the user config, as the default for new sessions. */
  save: z.boolean().optional(),
  /** Drop this session's changes and follow the config again (applied before the others). */
  reset: z.boolean().optional(),
});
export type SessionSetRolesParams = z.infer<typeof SessionSetRolesParams>;

export interface InitializeResult {
  protocolVersion: number;
  engineVersion: string;
  workspaceRoot: string;
  models: { alias: string; ref: ModelRef; tier: Tier }[];
  agents: AgentSummary[];
  /** Set when the user is signed in to an organization whose policy applies. */
  org?: OrgInfo;
}

export interface OrgInfo {
  id: string;
  name: string;
  /** Policy revision. */
  version: string;
}

export const SessionCreateParams = z.object({
  agent: z.string().optional(),
  title: z.string().optional(),
  /** Defaults to `permissions.defaultMode`. */
  permissionMode: PermissionMode.optional(),
  /** Added to the session's system prompt (headless runs' `--instructions`). */
  instructions: z.string().max(20_000).optional(),
});
export type SessionCreateParams = z.infer<typeof SessionCreateParams>;

export interface SessionSummary {
  id: string;
  title: string;
  agent: string;
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  usage: Usage;
  costUsd: number;
  /** Saved versus running this session all-remote. */
  savingsUsd?: number;
  /** A turn is in progress (possibly driven by another client). */
  running?: boolean;
  /** Top-level sessions: the permission mode in effect. */
  permissionMode?: PermissionMode;
}

export const SessionGetParams = z.object({ sessionId: z.string() });
export type SessionGetParams = z.infer<typeof SessionGetParams>;

export interface SessionGetResult {
  session: SessionSummary;
  messages: Message[];
}

/** Context a client attaches to a prompt (editor selection, open file, diagnostics). */
export const Attachment = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    /** Workspace-relative path. */
    path: z.string(),
    /** 1-based, inclusive. Omit for the whole file. */
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  z.object({ kind: z.literal('text'), label: z.string(), text: z.string().max(200_000) }),
]);
export type Attachment = z.infer<typeof Attachment>;

export const SessionPromptParams = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
  attachments: z.array(Attachment).max(20).optional(),
  /** Per-turn routing override. `auto` defers to the configured policy. */
  route: RoutePreference.default('auto'),
  /** Review of local edits for this prompt; overrides `review.mode` (docs/review.md). */
  review: z.boolean().optional(),
  /**
   * While a turn runs: `queue` (the default) hands the prompt to the model at
   * the next step, and `interrupt` stops the turn and starts this one at once.
   * Ignored when the session is idle.
   */
  delivery: z.enum(['queue', 'interrupt']).optional(),
});
export type SessionPromptParams = z.input<typeof SessionPromptParams>;

export interface SessionPromptResult {
  /** The turn the prompt runs in: a new one, or (queued) the one already running. */
  turnId: string;
  /** Set when the prompt was queued: its ID, for `session.dequeue`. */
  queued?: string;
}

/** A prompt waiting for the running turn's next step. */
export interface QueuedPrompt {
  id: string;
  text: string;
}

/** The start of a turn, which a session can rewind to. */
export interface CheckpointInfo {
  turnId: string;
  /** Where the turn's prompt is in the transcript. */
  index: number;
  at: string;
  /** The prompt, shortened. */
  prompt: string;
  /** Files the turn changed with edit or write (workspace-relative). */
  files: string[];
}

export const SessionCheckpointsParams = z.object({ sessionId: z.string() });
export type SessionCheckpointsParams = z.infer<typeof SessionCheckpointsParams>;

export const SessionRewindParams = z.object({
  sessionId: z.string(),
  /** The checkpoint: the turn to go back to the start of. */
  turnId: z.string(),
  /** Files, the conversation (as a new session), or both. */
  restore: z.enum(['files', 'conversation', 'both']),
});
export type SessionRewindParams = z.infer<typeof SessionRewindParams>;

export interface SessionRewindResult {
  /** Files put back or removed. */
  files: string[];
  /** With the conversation: the new session, holding the history before the checkpoint. */
  session?: SessionSummary;
}

export const SessionDequeueParams = z.object({ sessionId: z.string(), id: z.string() });
export type SessionDequeueParams = z.infer<typeof SessionDequeueParams>;

export const SessionCancelParams = z.object({ sessionId: z.string() });
export type SessionCancelParams = z.infer<typeof SessionCancelParams>;

export const PermissionDecision = z.enum(['allow_once', 'allow_always', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionRespondParams = z.object({
  requestId: z.string(),
  decision: PermissionDecision,
  /**
   * With `allow_always`: also save the request's `rules` as allow rules in the
   * project's personal config (`.switchback/config.local.json`) or the user config.
   */
  save: z.enum(['project', 'user']).optional(),
});
export type PermissionRespondParams = z.infer<typeof PermissionRespondParams>;

export const SessionCompactParams = z.object({ sessionId: z.string() });
export type SessionCompactParams = z.infer<typeof SessionCompactParams>;

export const SessionSetModeParams = z.object({ sessionId: z.string(), mode: PermissionMode });
export type SessionSetModeParams = z.infer<typeof SessionSetModeParams>;

export const PermissionsListParams = z.object({ sessionId: z.string().optional() });
export type PermissionsListParams = z.infer<typeof PermissionsListParams>;

/** The rules in effect, where each came from, and the session's mode. */
export interface PermissionsListResult {
  mode?: PermissionMode;
  /** Modes this session may switch to (an organization can rule out `bypassPermissions`). */
  modes: PermissionMode[];
  levels: Record<'read' | 'edit' | 'bash' | 'web' | 'mcp', 'allow' | 'ask' | 'deny'>;
  rules: { rule: string; behavior: 'allow' | 'ask' | 'deny'; source: string }[];
  /** Whether bash commands run in the OS sandbox, and if not, why. */
  sandbox: { active: boolean; reason?: string };
}

/** A command the bash tool started in the background. */
export interface ShellInfo {
  id: string;
  sessionId: string;
  command: string;
  /** Epoch milliseconds. */
  startedAt: number;
  status: 'running' | 'exited' | 'killed';
  exitCode?: number;
}

export const ShellsListParams = z.object({ sessionId: z.string().optional() });
export type ShellsListParams = z.infer<typeof ShellsListParams>;

export const ShellsKillParams = z.object({ shellId: z.string() });
export type ShellsKillParams = z.infer<typeof ShellsKillParams>;

export const EscalationRespondParams = z.object({
  requestId: z.string(),
  approve: z.boolean(),
});
export type EscalationRespondParams = z.infer<typeof EscalationRespondParams>;

export interface AgentSummary {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project';
  route: RoutePreference;
  model?: string;
  /** Remote spend allowed per invocation as a subagent. */
  budgetUsd?: number;
}

export const UsagePeriod = z.enum(['today', 'week', 'month']);
export type UsagePeriod = z.infer<typeof UsagePeriod>;

export const UsageGetParams = z.object({
  /** `week` is the last 7 days including today. Defaults to the calendar month. */
  period: UsagePeriod.optional(),
  /** A session and its subagents over their whole life, instead of a period (the receipt). */
  sessionId: z.string().optional(),
});
export type UsageGetParams = z.infer<typeof UsageGetParams>;

/** Model calls grouped by one key (a routing rule, an agent, or `provider/model`). */
export interface UsageRow {
  key: string;
  calls: number;
  usage: Usage;
  costUsd: number;
  savingsUsd: number;
}

/** One finding from a review of local edits. */
export interface ReviewIssue {
  file: string;
  line?: number | null;
  severity: 'bug' | 'risk' | 'nit';
  comment: string;
}

export interface McpServerInfo {
  name: string;
  state: 'connected' | 'failed' | 'disabled' | 'untrusted';
  tools: number;
  error?: string;
}

export interface McpListResult {
  servers: McpServerInfo[];
}

export interface UsageReport {
  period: { from: string; to: string };
  byTier: Record<Tier, { usage: Usage; costUsd: number }>;
  /**
   * What the local calls would have cost on the reference remote model, with
   * prompt-cache pricing for what the previous call already sent.
   */
  estimatedSavingsUsd: number;
  /** The model savings are measured against: the first configured remote model. */
  referenceModel?: string;
  budget: { dailyUsd?: number; monthlyUsd?: number; spentTodayUsd: number; spentMonthUsd: number };
  /** Why calls were routed where they were, most expensive first. */
  byRule?: UsageRow[];
  byAgent?: UsageRow[];
  byModel?: UsageRow[];
  /** Share of remote input tokens served from the provider's prompt cache (0 to 1). */
  remoteCacheHitRate?: number;
}

export interface Methods {
  initialize: { params: InitializeParams; result: InitializeResult };
  'session.create': { params: SessionCreateParams; result: SessionSummary };
  'session.list': { params: Record<string, never>; result: SessionSummary[] };
  'session.get': { params: SessionGetParams; result: SessionGetResult };
  'session.prompt': { params: SessionPromptParams; result: SessionPromptResult };
  /** Stop the running turn and its background subagents, and drop queued prompts. */
  'session.cancel': { params: SessionCancelParams; result: { cancelled: boolean } };
  /** The session's checkpoints, oldest first. */
  'session.checkpoints': { params: SessionCheckpointsParams; result: CheckpointInfo[] };
  /** Go back to a checkpoint: files, the conversation (forked; the original stays), or both. */
  'session.rewind': { params: SessionRewindParams; result: SessionRewindResult };
  /** Withdraw a queued prompt before it's delivered; `removed: false` if it already was. */
  'session.dequeue': { params: SessionDequeueParams; result: { removed: boolean } };
  /** Compact now (the engine also compacts automatically). Fails while a turn runs. */
  'session.compact': { params: SessionCompactParams; result: { compacted: boolean } };
  'permission.respond': { params: PermissionRespondParams; result: { ok: true } };
  'escalation.respond': { params: EscalationRespondParams; result: { ok: true } };
  'agents.list': { params: Record<string, never>; result: AgentSummary[] };
  'usage.get': { params: UsageGetParams; result: UsageReport };
  /** MCP servers: connection state and tool counts, plus project servers awaiting trust. */
  'mcp.list': { params: Record<string, never>; result: McpListResult };
  shutdown: { params: Record<string, never>; result: { ok: true } };
  'daemon.retire': { params: DaemonRetireParams; result: DaemonRetireResult };
  /** A session's roles: config, plus what the session changed. */
  'session.roles': { params: SessionRolesParams; result: SessionRoles };
  /** Change a session's roles; optionally save them as the user's defaults. */
  'session.setRoles': {
    params: SessionSetRolesParams;
    result: SessionRoles & { savedTo?: string };
  };
  /** Switch a session's permission mode; refused for modes the organization rules out. */
  'session.setMode': { params: SessionSetModeParams; result: { mode: PermissionMode } };
  'permissions.list': { params: PermissionsListParams; result: PermissionsListResult };
  /** Background shells, all or one session's. */
  'shells.list': { params: ShellsListParams; result: ShellInfo[] };
  'shells.kill': { params: ShellsKillParams; result: ShellInfo };
}

export type MethodName = keyof Methods;

// ---------------------------------------------------------------------------
// Engine -> client events (JSON-RPC notifications with method "event")
// ---------------------------------------------------------------------------

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
    } & SessionScoped)
  | ({
      type: 'subagent.completed';
      childSessionId: string;
      agent: string;
      ok: boolean;
      background?: boolean;
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
  | ({ type: 'turn.completed'; turnId: string; stopReason: StopReason } & SessionScoped)
  | ({ type: 'error'; turnId?: string; message: string } & SessionScoped)
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  /** Configuration changed while running (e.g. an organization policy update). */
  | { type: 'config.updated'; org?: OrgInfo; notes: string[] };

export type EngineEventType = EngineEvent['type'];
