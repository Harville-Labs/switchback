/**
 * Session persistence. Each session is one JSONL file: a header line, then one
 * line per message. Messages are only ever appended, never rewritten, which
 * keeps crash recovery trivial and preserves provider cache/thinking prefixes.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Message } from '@harness/protocol';

export interface SessionHeader {
  id: string;
  title: string;
  agent: string;
  parentId?: string;
  workspaceRoot: string;
  createdAt: string;
  /** Frozen at creation so the cached prompt prefix never changes mid-session. */
  system: string;
}

export interface StoredSession {
  header: SessionHeader;
  messages: Message[];
}

export interface SessionStore {
  create(header: SessionHeader): void;
  append(id: string, message: Message): void;
  load(id: string): StoredSession | undefined;
  list(): SessionHeader[];
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, StoredSession>();
  create(header: SessionHeader) {
    this.sessions.set(header.id, { header, messages: [] });
  }
  append(id: string, message: Message) {
    this.sessions.get(id)?.messages.push(message);
  }
  load(id: string) {
    return this.sessions.get(id);
  }
  list() {
    return [...this.sessions.values()].map((s) => s.header);
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
    return join(this.dir, `${id}.jsonl`);
  }

  create(header: SessionHeader) {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(header.id), `${JSON.stringify({ header })}\n`);
  }

  append(id: string, message: Message) {
    appendFileSync(this.file(id), `${JSON.stringify({ message })}\n`);
  }

  load(id: string): StoredSession | undefined {
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

  list(): SessionHeader[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => this.load(f.slice(0, -'.jsonl'.length))?.header)
      .filter((h): h is SessionHeader => h !== undefined);
  }
}
