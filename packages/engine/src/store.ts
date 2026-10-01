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
} from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@switchback/protocol';

export interface SessionHeader {
  id: string;
  title: string;
  agent: string;
  parentId?: string;
  workspaceRoot: string;
  /** Set for subagents isolated in a git worktree: where their tools operate. */
  worktree?: { path: string; root: string; branch: string };
  createdAt: string;
  /** Frozen at creation so the cached prompt prefix never changes mid-session. */
  system: string;
}

export interface StoredSession {
  header: SessionHeader;
  messages: Message[];
}

export interface StoredSessionInfo {
  header: SessionHeader;
  /** ISO time of the last write. */
  updatedAt: string;
}

export interface SessionStore {
  create(header: SessionHeader): void;
  append(id: string, message: Message): void;
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
  load(id: string) {
    return this.sessions.get(id);
  }
  list() {
    return [...this.sessions.values()].map(({ header, updatedAt }) => ({ header, updatedAt }));
  }
}

export class FileSessionStore implements SessionStore {
  /**
   * Sessions are written on their first message, so the header carries the
   * title (set from the first prompt) and unused sessions leave no files.
   */
  private pending = new Map<string, SessionHeader>();

  constructor(private readonly dir: string) {}

  private file(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
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
    }
    appendFileSync(this.file(id), `${JSON.stringify({ message })}\n`);
  }

  load(id: string): StoredSession | undefined {
    const pending = this.pending.get(id);
    if (pending) return { header: pending, messages: [] };
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
    return header ? { header, messages } : undefined;
  }

  list(): StoredSessionInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: StoredSessionInfo[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(this.dir, f);
      const header = readHeader(file);
      if (header) out.push({ header, updatedAt: statSync(file).mtime.toISOString() });
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
