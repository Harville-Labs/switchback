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
});
export type InitializeParams = z.infer<typeof InitializeParams>;

export interface InitializeResult {
  protocolVersion: number;
  engineVersion: string;
  workspaceRoot: string;
  models: { alias: string; ref: ModelRef; tier: Tier }[];
  agents: AgentSummary[];
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
}

export const SessionGetParams = z.object({ sessionId: z.string() });
export type SessionGetParams = z.infer<typeof SessionGetParams>;

export interface SessionGetResult {
  session: SessionSummary;
  messages: Message[];
}

export const SessionPromptParams = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
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
}

export interface UsageReport {
  period: { from: string; to: string };
  byTier: Record<Tier, { usage: Usage; costUsd: number }>;
  /** What the local tokens would have cost on the configured reference remote model. */
  estimatedSavingsUsd: number;
  budget: { dailyUsd?: number; monthlyUsd?: number; spentTodayUsd: number; spentMonthUsd: number };
}

export interface Methods {
  initialize: { params: InitializeParams; result: InitializeResult };
  'session.create': { params: SessionCreateParams; result: SessionSummary };
  'session.list': { params: Record<string, never>; result: SessionSummary[] };
  'session.get': { params: SessionGetParams; result: SessionGetResult };
  'session.prompt': { params: SessionPromptParams; result: SessionPromptResult };
  'session.cancel': { params: SessionCancelParams; result: { cancelled: boolean } };
  'permission.respond': { params: PermissionRespondParams; result: { ok: true } };
  'escalation.respond': { params: EscalationRespondParams; result: { ok: true } };
  'agents.list': { params: Record<string, never>; result: AgentSummary[] };
  'usage.get': { params: Record<string, never>; result: UsageReport };
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
      /** Unified diff of what the call would change, for edits. */
      preview?: string;
    } & SessionScoped)
  | ({
      type: 'escalation.requested';
      requestId: string;
      reason: string;
      target: ModelRef;
    } & SessionScoped)
  | ({
      type: 'subagent.started';
      childSessionId: string;
      agent: string;
      task: string;
    } & SessionScoped)
  | ({
      type: 'subagent.completed';
      childSessionId: string;
      agent: string;
      ok: boolean;
    } & SessionScoped)
  | ({ type: 'usage.updated'; usage: Usage; costUsd: number; tier: Tier } & SessionScoped)
  | ({ type: 'turn.completed'; turnId: string; stopReason: StopReason } & SessionScoped)
  | ({ type: 'error'; turnId?: string; message: string } & SessionScoped)
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export type EngineEventType = EngineEvent['type'];
