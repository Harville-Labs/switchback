/**
 * The engine's sessions: those in memory, and those in the store that load on
 * first use. Appending writes through to the store (transcripts are
 * append-only, invariant 4).
 */
import { ErrorCode, type Message, RpcError } from '@switchback/protocol';
import { SignalTracker } from '@switchback/router';
import type { SwitchbackConfig } from './config.ts';
import type { LiveSession } from './live-session.ts';
import { privateReason } from './privacy.ts';
import type { SessionHeader, SessionStore } from './store.ts';

export class SessionRegistry {
  private sessions = new Map<string, LiveSession>();

  constructor(
    private readonly store: SessionStore,
    private readonly config: () => SwitchbackConfig,
    private readonly now: () => Date,
  ) {}

  /** Start a session: stored at once, so it survives a restart even before its first message. */
  create(header: SessionHeader, extra: Partial<LiveSession> = {}): LiveSession {
    this.store.create(header);
    const parent = header.parentId ? this.sessions.get(header.parentId) : undefined;
    return this.track({
      header,
      messages: [],
      updatedAt: header.createdAt,
      ...extra,
      depth: parent ? parent.depth + 1 : 0,
    });
  }

  /**
   * A new top-level session with the first `upTo` messages of another. The
   * original is untouched (transcripts are append-only); the copy keeps its
   * system prompt and prefix, so prompt caches still hit.
   */
  fork(source: LiveSession, upTo: number, id: string, now: string): LiveSession {
    const { parentId: _p, worktree: _w, ...header } = source.header;
    const copy = this.create({
      ...header,
      id,
      title: `${source.header.title || 'session'} (rewound)`,
      createdAt: now,
    });
    for (const m of source.messages.slice(0, upTo)) this.append(copy, m);
    return copy;
  }

  /** A session in memory, or loaded from the store; throws when there's neither. */
  live(sessionId: string): LiveSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const stored = this.store.load(sessionId);
    if (!stored) throw new RpcError(ErrorCode.SessionNotFound, `session ${sessionId} not found`);
    const { header, messages } = stored;
    const parent = header.parentId ? this.sessions.get(header.parentId) : undefined;
    const priv = privateReason(messages);
    return this.track({
      header,
      messages,
      updatedAt: this.now().toISOString(),
      depth: parent ? parent.depth + 1 : header.parentId ? 1 : 0,
      ...(priv ? { private: priv } : {}),
    });
  }

  /** Only sessions already in memory. */
  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  inMemory(): IterableIterator<LiveSession> {
    return this.sessions.values();
  }

  children(sessionId: string): LiveSession[] {
    return [...this.sessions.values()].filter((c) => c.header.parentId === sessionId);
  }

  /** Every stored session, with when it last changed. */
  stored(): { header: SessionHeader; updatedAt: string }[] {
    return this.store.list();
  }

  append(s: LiveSession, message: Message): void {
    s.private ??= privateReason([message]);
    s.messages.push(message);
    s.updatedAt = this.now().toISOString();
    this.store.append(s.header.id, message);
  }

  /** The top-level session of a subagent (or the session itself). */
  top(s: LiveSession): LiveSession {
    let top = s;
    while (top.header.parentId) {
      const parent = this.sessions.get(top.header.parentId);
      if (!parent) break;
      top = parent;
    }
    return top;
  }

  /** A session and every subagent session under it, live or stored. */
  tree(sessionId: string): Set<string> {
    const children = new Map<string, string[]>();
    const link = (id: string, parent: string | undefined) => {
      if (parent) children.set(parent, [...(children.get(parent) ?? []), id]);
    };
    for (const { header } of this.store.list()) link(header.id, header.parentId);
    for (const s of this.sessions.values()) link(s.header.id, s.header.parentId);
    const tree = new Set<string>();
    const walk = (id: string) => {
      if (tree.has(id)) return;
      tree.add(id);
      for (const c of children.get(id) ?? []) walk(c);
    };
    walk(sessionId);
    return tree;
  }

  private track(fields: Omit<LiveSession, 'signals' | 'background' | 'inbox'>): LiveSession {
    const live: LiveSession = {
      ...fields,
      signals: new SignalTracker(this.config().routing.escalation),
      background: new Map(),
      inbox: [],
    };
    this.sessions.set(live.header.id, live);
    return live;
  }
}
