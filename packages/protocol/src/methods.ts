/**
 * The engine protocol: every request a client can make and every event the
 * engine can emit. TUI, VS Code, and headless `harness run` all speak exactly
 * this surface. Adding a capability means adding it here first.
 */
import { z } from 'zod';
import type { Message, ModelRef, StopReason, Tier, Usage } from './transcript.ts';

export const PROTOCOL_VERSION = 1;

export const RoutePreference = z.enum(['auto', 'local', 'remote']);
export type RoutePreference = z.infer<typeof RoutePreference>;

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
  /** A turn is in progress (possibly driven by another client). */
  running?: boolean;
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
});
export type SessionPromptParams = z.input<typeof SessionPromptParams>;

export interface SessionPromptResult {
  turnId: string;
}

export const SessionCancelParams = z.object({ sessionId: z.string() });
export type SessionCancelParams = z.infer<typeof SessionCancelParams>;

export const PermissionDecision = z.enum(['allow_once', 'allow_always', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionRespondParams = z.object({
  requestId: z.string(),
  decision: PermissionDecision,
});
export type PermissionRespondParams = z.infer<typeof PermissionRespondParams>;

export const SessionCompactParams = z.object({ sessionId: z.string() });
export type SessionCompactParams = z.infer<typeof SessionCompactParams>;

export const EscalationRespondParams = z.object({
  requestId: z.string(),
  approve: z.boolean(),
});
export type EscalationRespondParams = z.infer<typeof EscalationRespondParams>;

export interface AgentSummary {
  name: string;
  description: string;
  source: 'builtin' | 'user' | 'project' | 'claude-compat';
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
  /** What the local tokens would have cost on the configured reference remote model. */
  estimatedSavingsUsd: number;
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
  'session.cancel': { params: SessionCancelParams; result: { cancelled: boolean } };
  /** Compact now (the engine also compacts automatically). Fails while a turn runs. */
  'session.compact': { params: SessionCompactParams; result: { compacted: boolean } };
  'permission.respond': { params: PermissionRespondParams; result: { ok: true } };
  'escalation.respond': { params: EscalationRespondParams; result: { ok: true } };
  'agents.list': { params: Record<string, never>; result: AgentSummary[] };
  'usage.get': { params: UsageGetParams; result: UsageReport };
  /** MCP servers: connection state and tool counts, plus project servers awaiting trust. */
  'mcp.list': { params: Record<string, never>; result: McpListResult };
  shutdown: { params: Record<string, never>; result: { ok: true } };
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
    } & SessionScoped)
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
  | ({ type: 'usage.updated'; usage: Usage; costUsd: number; tier: Tier } & SessionScoped)
  | ({ type: 'turn.completed'; turnId: string; stopReason: StopReason } & SessionScoped)
  | ({ type: 'error'; turnId?: string; message: string } & SessionScoped)
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  /** Configuration changed while running (e.g. an organization policy update). */
  | { type: 'config.updated'; org?: OrgInfo; notes: string[] };

export type EngineEventType = EngineEvent['type'];
