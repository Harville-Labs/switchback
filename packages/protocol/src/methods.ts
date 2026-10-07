/**
 * The engine protocol: every request a client can make (events are in
 * events.ts). TUI, VS Code, and headless `switchback run` all speak exactly
 * this surface. Adding a capability means adding it here first.
 */
import { z } from 'zod';
import {
  MAX_IMAGE_BYTES,
  type Message,
  type ModelRef,
  type Tier,
  type Usage,
} from './transcript.ts';

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
  /** How clients should get the user's attention (`notifications` in config). */
  notifications?: NotificationSettings;
}

export interface NotificationSettings {
  mode: 'system' | 'bell' | 'off';
  /** Notify when a turn that ran at least this long finishes; 0 never. */
  afterSeconds: number;
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
  /** A pasted or dropped image. The engine checks the bytes, not just the declared type. */
  z.object({
    kind: z.literal('image'),
    /** Shown on the chip: a file name, or `image 1` for a pasted one. */
    name: z.string().max(200),
    /** Base64, no `data:` prefix. */
    data: z.string().max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
  }),
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

/** A slash command defined in a Markdown file (`.switchback/commands/`, `~/.config/switchback/commands/`). */
export interface CustomCommandInfo {
  name: string;
  description: string;
  /** What to type after the name, as shown in menus (`<file> [focus]`). */
  args?: string;
  /** `mcp`: an MCP server's prompt, named `<server>:<prompt>`. */
  source: 'user' | 'project' | 'mcp';
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
  /** Average output speed over the calls that were timed. */
  tokensPerSecond?: number;
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
  /** What `@<server>:<uri>` can attach. */
  resources?: McpResourceInfo[];
  /** What `/<server>:<prompt>` can run. */
  prompts?: McpPromptInfo[];
  error?: string;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; required?: true }[];
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
  /** Custom slash commands; a prompt of `/name args` runs one. */
  'commands.list': { params: Record<string, never>; result: CustomCommandInfo[] };
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
