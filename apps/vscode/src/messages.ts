/** Messages between the extension host and the chat webview. */
import type {
  EngineEvent,
  InitializeResult,
  PermissionDecision,
  RoutePreference,
  SessionSummary,
  UsageReport,
} from '@harness/protocol';

export type HostToWebview =
  | { type: 'ready'; init: InitializeResult; session: SessionSummary; route: RoutePreference }
  | { type: 'session'; session: SessionSummary }
  | { type: 'event'; event: EngineEvent }
  | { type: 'route'; route: RoutePreference }
  | { type: 'usage'; usage: UsageReport }
  | { type: 'prefill'; text: string }
  | { type: 'disconnected'; message: string };

export type WebviewToHost =
  | { type: 'loaded' }
  | { type: 'prompt'; text: string }
  | { type: 'cancel' }
  | { type: 'permission'; requestId: string; decision: PermissionDecision }
  | { type: 'escalation'; requestId: string; approve: boolean }
  | { type: 'setRoute'; route: RoutePreference }
  | { type: 'newSession'; agent?: string };
