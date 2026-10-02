/** Messages between the extension host and the chat webview. */
import type {
  EngineEvent,
  InitializeResult,
  Message,
  PermissionDecision,
  RoutePreference,
  SessionRoles,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import type { AttachChoice, EditorContextState } from './context.ts';

export type HostToWebview =
  | { type: 'ready'; init: InitializeResult; session: SessionSummary; route: RoutePreference }
  | { type: 'session'; session: SessionSummary }
  | { type: 'event'; event: EngineEvent }
  | { type: 'route'; route: RoutePreference }
  | { type: 'usage'; usage: UsageReport }
  | { type: 'prefill'; text: string }
  /** What the user is looking at, offered as attachable context. */
  | { type: 'context'; state: EditorContextState }
  /** Turn on the selection chip and focus the input (Ask About Selection). */
  | { type: 'attachSelection' }
  | { type: 'history'; session: SessionSummary; messages: Message[] }
  /** Which models fill the session's roles; sent whenever the session changes. */
  | { type: 'roles'; roles: SessionRoles }
  | { type: 'disconnected'; message: string };

export type WebviewToHost =
  | { type: 'loaded' }
  | { type: 'prompt'; text: string; attach?: AttachChoice }
  | { type: 'cancel' }
  | { type: 'permission'; requestId: string; decision: PermissionDecision }
  | { type: 'escalation'; requestId: string; approve: boolean }
  | { type: 'setRoute'; route: RoutePreference }
  | { type: 'newSession'; agent?: string }
  | { type: 'copy'; text: string }
  | { type: 'insert'; text: string }
  | { type: 'openLink'; href: string }
  | { type: 'openHistory' }
  /** Open the picker for one role (the chat's role buttons). */
  | { type: 'chooseRole'; role: RoleName | 'reset' }
  | { type: 'chooseAgent' };

export type RoleName = 'start' | 'escalate' | 'review' | 'subagents';
