/**
 * New sessions and how sessions are described to clients. A session's system
 * prompt is assembled here, once: it's frozen for the session's life
 * (invariant 7).
 */
import {
  ErrorCode,
  type PermissionMode,
  RpcError,
  type SessionSummary,
} from '@switchback/protocol';
import type { AgentCatalog } from './agent-catalog.ts';
import type { SwitchbackConfig } from './config.ts';
import type { UsageLedger } from './ledger.ts';
import type { Library } from './library.ts';
import type { LiveSession } from './live-session.ts';
import type { OrgStatus } from './org/policy.ts';
import { assertModeAllowed } from './permissions/modes.ts';
import type { SessionRegistry } from './session-registry.ts';
import { skillsSection } from './skills.ts';
import type { SessionHeader } from './store.ts';
import { systemPrompt } from './system-prompt.ts';
import { shellOf } from './tools/process.ts';
import type { Worktree } from './worktree.ts';

export interface NewSession {
  agent?: string;
  title?: string;
  parentId?: string;
  worktree?: Worktree;
  permissionMode?: PermissionMode;
  instructions?: string;
}

export interface SessionFactoryDeps {
  workspaceRoot: string;
  config(): SwitchbackConfig;
  org(): OrgStatus | undefined;
  /** The workspace's AGENTS.md. */
  instructions: string | undefined;
  agents: AgentCatalog;
  library: Library;
  sessions: SessionRegistry;
  ledger: UsageLedger;
  now(): Date;
}

export function newSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

export class SessionFactory {
  constructor(private readonly deps: SessionFactoryDeps) {}

  create(params: NewSession): LiveSession {
    const config = this.deps.config();
    const { workspaceRoot } = this.deps;
    const agentName = params.agent ?? config.defaultAgent;
    // Subagents run as agents the parent already saw; only top-level sessions reread the files.
    if (!params.parentId) this.deps.agents.refresh();
    const agent = this.deps.agents.get(agentName);
    if (!agent) throw new RpcError(ErrorCode.InvalidParams, `unknown agent "${agentName}"`);
    if (params.permissionMode) assertModeAllowed(params.permissionMode, this.deps.org());
    const wt = params.worktree;
    const header: SessionHeader = {
      id: newSessionId(),
      title: params.title ?? '',
      agent: agent.name,
      ...(params.parentId ? { parentId: params.parentId } : {}),
      workspaceRoot,
      ...(wt ? { worktree: { path: wt.path, root: wt.root, branch: wt.branch } } : {}),
      createdAt: this.deps.now().toISOString(),
      system: systemPrompt({
        agent,
        workspaceRoot,
        root: wt?.root ?? workspaceRoot,
        shell: shellOf(config.bash).name,
        ...(this.deps.instructions ? { project: this.deps.instructions } : {}),
        ...(params.instructions ? { session: params.instructions } : {}),
        skills: skillsSection(this.deps.library.skills().values()),
      }),
    };
    return this.deps.sessions.create(
      header,
      params.permissionMode && !params.parentId ? { mode: params.permissionMode } : {},
    );
  }

  /** Top-level sessions in this workspace, most recently updated first. */
  list(): SessionSummary[] {
    return this.deps.sessions
      .stored()
      .filter(({ header }) => !header.parentId && header.workspaceRoot === this.deps.workspaceRoot)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ header, updatedAt }) => this.summaryOf(header, updatedAt));
  }

  summary(s: LiveSession): SessionSummary {
    return this.summaryOf(s.header, s.updatedAt);
  }

  summaryOf(header: SessionHeader, updatedAt: string): SessionSummary {
    const cost = this.deps.ledger.sessionCost(header.id);
    const live = this.deps.sessions.get(header.id);
    return {
      id: header.id,
      title: header.title,
      agent: header.agent,
      ...(header.parentId ? { parentId: header.parentId } : {}),
      createdAt: header.createdAt,
      updatedAt,
      usage: cost.usage,
      costUsd: cost.costUsd,
      savingsUsd: cost.savingsUsd,
      ...(live?.controller ? { running: true } : {}),
      ...(header.parentId
        ? {}
        : { permissionMode: live?.mode ?? this.deps.config().permissions.defaultMode }),
    };
  }
}
