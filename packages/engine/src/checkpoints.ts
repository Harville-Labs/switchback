/**
 * Checkpoints: a mark at the start of every turn, and the content each file
 * had before the turn first changed it (through edit or write). Rewinding
 * puts every file changed since a checkpoint back as it was; files created
 * since then are removed. Changes made by shell commands aren't tracked.
 *
 * Snapshots are content-addressed and written as soon as they're taken, so a
 * crash mid-turn still leaves the way back.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { CheckpointInfo } from '@switchback/protocol';

/** One line of a session's checkpoint log. */
type Entry =
  | { kind: 'turn'; turnId: string; index: number; at: string; prompt: string }
  /** `hash` undefined: the file didn't exist before the turn. */
  | { kind: 'file'; turnId: string; path: string; hash?: string };

export interface CheckpointStore {
  append(sessionId: string, entry: Entry): void;
  entries(sessionId: string): Entry[];
  putBlob(content: string): string;
  getBlob(hash: string): string;
}

export class MemoryCheckpointStore implements CheckpointStore {
  private logs = new Map<string, Entry[]>();
  private blobs = new Map<string, string>();
  append(sessionId: string, entry: Entry) {
    this.logs.set(sessionId, [...(this.logs.get(sessionId) ?? []), entry]);
  }
  entries(sessionId: string) {
    return this.logs.get(sessionId) ?? [];
  }
  putBlob(content: string) {
    const hash = hashOf(content);
    this.blobs.set(hash, content);
    return hash;
  }
  getBlob(hash: string) {
    const content = this.blobs.get(hash);
    if (content === undefined) throw new Error(`checkpoint content ${hash} is missing`);
    return content;
  }
}

/** `<dir>/<session>.jsonl` logs and `<dir>/blobs/<hash>` contents. */
export class FileCheckpointStore implements CheckpointStore {
  constructor(private readonly dir: string) {}
  append(sessionId: string, entry: Entry) {
    const file = join(this.dir, `${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }
  entries(sessionId: string) {
    const file = join(this.dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Entry];
        } catch {
          return []; // a torn last line from a crash
        }
      });
  }
  putBlob(content: string) {
    const hash = hashOf(content);
    const file = join(this.dir, 'blobs', hash);
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return hash;
  }
  getBlob(hash: string) {
    return readFileSync(join(this.dir, 'blobs', hash), 'utf8');
  }
}

function hashOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class Checkpoints {
  /** The turn each session is in, and the files it has already saved this turn. */
  private current = new Map<string, { turnId: string; saved: Set<string> }>();

  constructor(private readonly store: CheckpointStore) {}

  /** A new turn starts at message `index` (where its prompt goes). */
  begin(sessionId: string, turnId: string, index: number, prompt: string, at: string): void {
    this.store.append(sessionId, { kind: 'turn', turnId, index, at, prompt: prompt.slice(0, 200) });
    this.current.set(sessionId, { turnId, saved: new Set() });
  }

  /** A file is about to change: keep what it held, the first time this turn. */
  note(sessionId: string, absolute: string, relative: string): void {
    const turn = this.current.get(sessionId);
    if (!turn || turn.saved.has(relative)) return;
    turn.saved.add(relative);
    const before = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
    this.store.append(sessionId, {
      kind: 'file',
      turnId: turn.turnId,
      path: relative,
      ...(before !== undefined ? { hash: this.store.putBlob(before) } : {}),
    });
  }

  /** The session's checkpoints, oldest first, with the files each turn changed. */
  list(sessionId: string): CheckpointInfo[] {
    const turns = new Map<string, CheckpointInfo>();
    for (const e of this.store.entries(sessionId)) {
      if (e.kind === 'turn')
        turns.set(e.turnId, {
          turnId: e.turnId,
          index: e.index,
          at: e.at,
          prompt: e.prompt,
          files: [],
        });
      else turns.get(e.turnId)?.files.push(e.path);
    }
    return [...turns.values()];
  }

  /**
   * Put every file changed since the checkpoint back as it was before that
   * turn. Returns the files restored (or removed), relative to `root`.
   */
  restoreFiles(sessionId: string, turnId: string, root: string): string[] {
    const entries = this.store.entries(sessionId);
    const start = entries.findIndex((e) => e.kind === 'turn' && e.turnId === turnId);
    if (start === -1) throw new Error(`no checkpoint ${turnId} in this session`);
    // The earliest snapshot of each file since the checkpoint is what it held then.
    const first = new Map<string, string | undefined>();
    for (const e of entries.slice(start))
      if (e.kind === 'file' && !first.has(e.path)) first.set(e.path, e.hash);
    for (const [path, hash] of first) {
      const file = join(root, path);
      if (hash === undefined) rmSync(file, { force: true });
      else {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, this.store.getBlob(hash));
      }
    }
    return [...first.keys()];
  }
}
