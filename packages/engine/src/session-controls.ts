/**
 * What a client can change about a session besides prompting it: its agent,
 * its permission level, and going back to a checkpoint. Also what the rest of
 * the engine asks about levels and records for checkpoints.
 */
import { realpathSync } from 'node:fs';
import {
  type CheckpointInfo,
  ErrorCode,
  type PermissionLevel,
  type PermissionsListResult,
  RpcError,
  type SessionEscalateResult,
  type SessionRewindParams,
  type SessionRewindResult,
  type SessionSummary,
} from '@switchback/protocol';
import type { Effort } from '@switchback/providers';
import type { AgentDefinition } from './agents.ts';
import type { Checkpoints } from './checkpoints.ts';
import { agentNameOf, type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { PermissionGate } from './permissions/gate.ts';
import { allowedLevels, assertLevelAllowed } from './permissions/levels.ts';
import type { SessionRegistry } from './session-registry.ts';
import { resolveInWorkspace, toWorkspacePath } from './tools/index.ts';
import type { CommandRunner } from './tools/process.ts';

export interface SessionControlsDeps {
  sessions: SessionRegistry;
  checkpoints: Checkpoints;
  gate(): PermissionGate;
  agent(name: string): AgentDefinition | undefined;
  commands(): CommandRunner;
  summary(s: LiveSession): SessionSummary;
  newSessionId(): string;
  now(): Date;
}

export class SessionControls {
  constructor(
    private readonly host: EngineHost,
    private readonly deps: SessionControlsDeps,
  ) {}

  levelOf(s: LiveSession): PermissionLevel {
    return this.host.top(s).level ?? this.host.config().permissions.level;
  }

  private changeLevel(top: LiveSession, level: PermissionLevel): void {
    top.level = level;
    this.host.emit({ type: 'permissions.changed', ...scope(top), level });
  }

  /** Climb one step at the running turn's next call, or at the next prompt. */
  escalate(sessionId: string): SessionEscalateResult {
    const s = this.host.top(this.deps.sessions.live(sessionId));
    s.escalateNow = true;
    return { when: s.controller ? 'next-step' : 'next-prompt' };
  }

  /** `session.setPermissions`. Subagents follow their top-level session, so this changes the tree. */
  setPermissions(sessionId: string, level: PermissionLevel): { level: PermissionLevel } {
    assertLevelAllowed(level, this.host.org());
    this.changeLevel(this.host.top(this.deps.sessions.live(sessionId)), level);
    return { level };
  }

  /** The agent a top-level session works as now; undefined for a subagent. */
  activeAgent(s: LiveSession): AgentDefinition | undefined {
    return s.depth === 0 ? this.deps.agent(agentNameOf(s)) : undefined;
  }

  /** The agents whose permissions apply to a session's calls. */
  agentsFor(s: LiveSession): AgentDefinition[] {
    const names = new Set([agentNameOf(s), agentNameOf(this.host.top(s))]);
    return [...names].flatMap((name) => this.deps.agent(name) ?? []);
  }

  /**
   * `session.setAgent` (ADR 0029). Only a top-level session switches, and
   * only to an agent that can lead one; the model hears with the next prompt.
   */
  setAgent(sessionId: string, name: string): { agent: string } {
    const s = this.deps.sessions.live(sessionId);
    if (s.depth > 0)
      throw new RpcError(ErrorCode.InvalidParams, "a subagent's agent can't be switched");
    const agent = this.deps.agent(name);
    if (!agent)
      throw new RpcError(
        ErrorCode.InvalidParams,
        `unknown agent "${name}"; agent.list shows the agents there are`,
      );
    if (agent.mode === 'subagent')
      throw new RpcError(
        ErrorCode.InvalidParams,
        `the ${name} agent only runs as a subagent; switch to one whose mode is primary or all`,
      );
    this.switchAgent(s, agent.name);
    return { agent: agent.name };
  }

  private switchAgent(top: LiveSession, name: string): void {
    const current = agentNameOf(top);
    if (current === name) return;
    this.deps.sessions.setAgent(top, name, current);
    this.host.emit({ type: 'agent.changed', ...scope(top), agent: name });
  }

  /**
   * An approved plan: back to the agent before the planning one, else the
   * default agent, else build. The model hears it in exit_plan_mode's result.
   */
  leavePlan(s: LiveSession, auto: boolean): void {
    const top = this.host.top(s);
    const current = agentNameOf(top);
    const { defaultAgent } = this.host.config();
    const back = [top.previousAgent, defaultAgent].find(
      (name) => name && name !== current && this.deps.agent(name),
    );
    this.switchAgent(top, back ?? 'build');
    if (auto && this.levelOf(top) === 'ask') this.changeLevel(top, 'auto');
  }

  /** `session.setEffort`. Only the top-level session's own calls use it; subagents keep theirs. */
  setEffort(sessionId: string, effort: Effort | null): { effort?: Effort } {
    const top = this.host.top(this.deps.sessions.live(sessionId));
    if (effort) top.effort = effort;
    else delete top.effort;
    this.host.emit({ type: 'effort.changed', ...scope(top), ...(effort ? { effort } : {}) });
    return effort ? { effort } : {};
  }

  /** `permissions.list`: the rules in effect, with their sources, and the session's level. */
  async permissions(sessionId?: string): Promise<PermissionsListResult> {
    const { read, edit, bash, web, websearch, mcp } = this.host.config().permissions;
    const sandbox = await this.deps.commands().sandboxState();
    return {
      sandbox: sandbox.active ? { active: true } : { active: false, reason: sandbox.reason },
      ...(sessionId ? { level: this.levelOf(this.deps.sessions.live(sessionId)) } : {}),
      allowedLevels: allowedLevels(this.host.org()),
      levels: { read, edit, bash, web, websearch, mcp },
      rules: this.deps.gate().policy().list(),
    };
  }

  /** A top-level turn with a prompt starts: the checkpoint it can be rewound to. */
  beginCheckpoint(s: LiveSession, turnId: string, prompt: string): void {
    const at = this.deps.now().toISOString();
    this.deps.checkpoints.begin(s.header.id, turnId, s.messages.length, prompt, at);
  }

  /** Snapshot a file before a turn first changes it, if it's in the top-level session's checkout. */
  noteCheckpoint(s: LiveSession, path: string): void {
    const top = this.host.top(s);
    // An isolated subagent's edits are on its own branch, not in the workspace.
    if (this.host.rootOf(s) !== this.host.rootOf(top)) return;
    let absolute: string;
    try {
      absolute = resolveInWorkspace(this.host.rootOf(top), path);
    } catch {
      return; // the tool will report the bad path
    }
    // resolveInWorkspace canonicalizes symlinks (macOS /var is /private/var); so must the root.
    const relative = toWorkspacePath(realpathSync(this.host.rootOf(top)), absolute);
    if (relative) this.deps.checkpoints.note(top.header.id, absolute, relative);
  }

  /** `session.checkpoints`. */
  listCheckpoints(sessionId: string): CheckpointInfo[] {
    const top = this.host.top(this.deps.sessions.live(sessionId));
    return this.deps.checkpoints.list(top.header.id);
  }

  /**
   * `session.rewind`: back to the start of a turn. Files are put back in the
   * workspace; the conversation goes on in a new session, since transcripts
   * are append-only.
   */
  rewind(params: SessionRewindParams): SessionRewindResult {
    const s = this.host.top(this.deps.sessions.live(params.sessionId));
    if (s.controller) throw new RpcError(ErrorCode.SessionBusy, 'session is running a turn');
    const checkpoint = this.deps.checkpoints
      .list(s.header.id)
      .find((c) => c.turnId === params.turnId);
    if (!checkpoint)
      throw new RpcError(ErrorCode.InvalidParams, `no checkpoint ${params.turnId} in this session`);
    const files =
      params.restore === 'conversation'
        ? []
        : this.deps.checkpoints.restoreFiles(s.header.id, checkpoint.turnId, this.host.rootOf(s));
    if (params.restore === 'files') return { files };
    const now = this.deps.now().toISOString();
    const copy = this.deps.sessions.fork(s, checkpoint.index, this.deps.newSessionId(), now);
    return { files, session: this.deps.summary(copy) };
  }
}
