/**
 * Session persistence. Each session is one JSONL file: a header line, then one
 * line per message. Messages are only ever appended, never rewritten, which
 * keeps crash recovery trivial and preserves provider cache/thinking prefixes.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Message, TitleSource } from '@switchback/protocol';

export interface SessionHeader {
  id: string;
  title: string;
  /** Who set `title`; absent in sessions from before titles had a source (the first prompt). */
  titleSource?: TitleSource;
  agent: string;
  parentId?: string;
  workspaceRoot: string;
  /** Set for subagents isolated in a git worktree: where their tools operate. */
  worktree?: { path: string; root: string; branch: string };
  createdAt: string;
  /** Frozen at creation so the cached prompt prefix never changes mid-session. */
  system: string;
  /** Hashes of the AGENTS.md files in `system`, to tell when they change (ADR 0017). */
  instructions?: { user?: string; project?: string };
}

/** The agent a session switched to (ADR 0029), and the one it switched from. */
export interface StoredAgent {
  agent: string;
  previous?: string;
}

export interface StoredSession {
  header: SessionHeader;
  messages: Message[];
  /** Set once the session switched agents; `header.agent` is the one it started with. */
  agent?: StoredAgent;
}

export interface StoredSessionInfo {
  header: SessionHeader;
  /** ISO time of the last write. */
  updatedAt: string;
  /** The agent it works as now, when it switched from `header.agent`. */
  agent?: string;
}

export interface SessionStore {
  create(header: SessionHeader): void;
  append(id: string, message: Message): void;
  /** Change the title without touching the transcript. */
  rename(id: string, title: string, source: TitleSource): void;
  /** Record the agent a session works as now, without touching the transcript. */
  setAgent(id: string, agent: StoredAgent): void;
  load(id: string): StoredSession | undefined;
  list(): StoredSessionInfo[];
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession & { updatedAt: string }>();
  create(header: SessionHeader) {
    this.sessions.set(header.id, { header, messages: [], updatedAt: new Date().toISOString() });
  }
  append(id: string, message: Message) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.messages.push(message);
    s.updatedAt = new Date().toISOString();
  }
  rename(id: string, title: string, source: TitleSource) {
    const s = this.sessions.get(id);
    if (s) s.header = { ...s.header, title, titleSource: source };
  }
  setAgent(id: string, agent: StoredAgent) {
    const s = this.sessions.get(id);
    if (s) s.agent = agent;
  }
  load(id: string) {
    return this.sessions.get(id);
  }
  list() {
    return [...this.sessions.values()].map(({ header, updatedAt, agent }) => ({
      header,
      updatedAt,
      ...(agent ? { agent: agent.agent } : {}),
    }));
  }
}

export class FileSessionStore implements SessionStore {
  /**
   * Sessions are written on their first message, so the header carries the
   * title (set from the first prompt) and unused sessions leave no files.
   * A later title goes in `<id>.title.json` beside the transcript, and the
   * agent it switched to in `<id>.agent.json`: the header line is never
   * rewritten, and listing reads only headers and these.
   */
  private pending = new Map<string, SessionHeader>();
  /** Agent switches in sessions not written yet. */
  private pendingAgents = new Map<string, StoredAgent>();

  constructor(private readonly dir: string) {}

  private file(id: string, ext = 'jsonl') {
    if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return join(this.dir, `${id}.${ext}`);
  }

  create(header: SessionHeader) {
    this.file(header.id); // validate early
    this.pending.set(header.id, header);
  }

  append(id: string, message: Message) {
    const header = this.pending.get(id);
    if (header) {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file(id), `${JSON.stringify({ header })}\n`);
      this.pending.delete(id);
      const agent = this.pendingAgents.get(id);
      if (agent) this.setAgent(id, agent);
    }
    appendFileSync(this.file(id), `${JSON.stringify({ message })}\n`);
  }

  rename(id: string, title: string, source: TitleSource) {
    const pending = this.pending.get(id);
    if (pending) {
      this.pending.set(id, { ...pending, title, titleSource: source });
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(id, 'title.json'), `${JSON.stringify({ title, source })}\n`);
  }

  setAgent(id: string, agent: StoredAgent) {
    if (this.pending.has(id)) {
      this.pendingAgents.set(id, agent);
      return;
    }
    this.pendingAgents.delete(id);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file(id, 'agent.json'), `${JSON.stringify(agent)}\n`);
  }

  private storedAgent(id: string): StoredAgent | undefined {
    const file = this.file(id, 'agent.json');
    if (!existsSync(file)) return undefined;
    try {
      const a = JSON.parse(readFileSync(file, 'utf8')) as { agent?: unknown; previous?: unknown };
      if (typeof a.agent !== 'string') return undefined;
      return {
        agent: a.agent,
        ...(typeof a.previous === 'string' ? { previous: a.previous } : {}),
      };
    } catch {
      return undefined; // a torn write: the session goes on as the agent it started with
    }
  }

  /** The header with any later title over the one it was written with. */
  private retitled(header: SessionHeader): SessionHeader {
    const file = this.file(header.id, 'title.json');
    if (!existsSync(file)) return header;
    try {
      const t = JSON.parse(readFileSync(file, 'utf8')) as { title?: unknown; source?: unknown };
      if (typeof t.title !== 'string') return header;
      const source = t.source === 'user' || t.source === 'compaction' ? t.source : 'prompt';
      return { ...header, title: t.title, titleSource: source };
    } catch {
      return header; // a torn write: the title it had before is still right
    }
  }

  load(id: string): StoredSession | undefined {
    const pending = this.pending.get(id);
    if (pending) {
      const agent = this.pendingAgents.get(id);
      return { header: pending, messages: [], ...(agent ? { agent } : {}) };
    }
    const file = this.file(id);
    if (!existsSync(file)) return undefined;
    let header: SessionHeader | undefined;
    const messages: Message[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { header?: SessionHeader; message?: Message };
        if (row.header) header = row.header;
        if (row.message) messages.push(row.message);
      } catch {
        break; // torn write at the tail; everything before it is intact
      }
    }
    if (!header) return undefined;
    const agent = this.storedAgent(id);
    return { header: this.retitled(header), messages, ...(agent ? { agent } : {}) };
  }

  list(): StoredSessionInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: StoredSessionInfo[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(this.dir, f);
      const header = readHeader(file);
      if (!header) continue;
      const agent = this.storedAgent(header.id)?.agent;
      out.push({
        header: this.retitled(header),
        updatedAt: statSync(file).mtime.toISOString(),
        ...(agent ? { agent } : {}),
      });
    }
    return out;
  }
}

/** Read only the first line; listing must not parse every transcript. */
function readHeader(file: string): SessionHeader | undefined {
  const fd = openSync(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = 0;
    // Headers embed the system prompt, so they can be large; cap at 8 MB.
    while (pos < 8 * 1024 * 1024) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(buf.subarray(0, nl === -1 ? n : nl)));
      if (nl !== -1) break;
      pos += n;
    }
    return (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { header?: SessionHeader })
      .header;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
