/**
 * What a client can change about a session besides prompting it: its
 * permission mode, and going back to a checkpoint. Also what the rest of the
 * engine asks about modes and records for checkpoints.
 */
import { realpathSync } from 'node:fs';
import {
  type CheckpointInfo,
  ErrorCode,
  type PermissionMode,
  type PermissionsListResult,
  RpcError,
  type SessionRewindParams,
  type SessionRewindResult,
  type SessionSummary,
} from '@switchback/protocol';
import type { Checkpoints } from './checkpoints.ts';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';
import type { PermissionGate } from './permissions/gate.ts';
import { allowedModes, assertModeAllowed } from './permissions/modes.ts';
import type { SessionRegistry } from './session-registry.ts';
import { resolveInWorkspace, toWorkspacePath } from './tools/index.ts';
import type { CommandRunner } from './tools/process.ts';

export interface SessionControlsDeps {
  sessions: SessionRegistry;
  checkpoints: Checkpoints;
  gate(): PermissionGate;
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

  modeOf(s: LiveSession): PermissionMode {
    return this.host.top(s).mode ?? this.host.config().permissions.defaultMode;
  }

  /** `told`: the model already knows; otherwise it hears with the next prompt. */
  changeMode(top: LiveSession, mode: PermissionMode, told: boolean): void {
    top.mode = mode;
    if (told) top.toldMode = mode;
    this.host.emit({ type: 'mode.changed', ...scope(top), mode });
  }

  /** `session.setMode`. Subagents follow their top-level session, so this changes the tree. */
  setMode(sessionId: string, mode: PermissionMode): { mode: PermissionMode } {
    assertModeAllowed(mode, this.host.org());
    this.changeMode(this.host.top(this.deps.sessions.live(sessionId)), mode, false);
    return { mode };
  }

  /** `permissions.list`: the rules in effect, with their sources, and the session's mode. */
  async permissions(sessionId?: string): Promise<PermissionsListResult> {
    const { read, edit, bash, web, mcp } = this.host.config().permissions;
    const sandbox = await this.deps.commands().sandboxState();
    return {
      sandbox: sandbox.active ? { active: true } : { active: false, reason: sandbox.reason },
      ...(sessionId ? { mode: this.modeOf(this.deps.sessions.live(sessionId)) } : {}),
      modes: allowedModes(this.host.org()),
      levels: { read, edit, bash, web, mcp },
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
