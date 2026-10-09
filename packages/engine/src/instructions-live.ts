/**
 * AGENTS.md changes reaching running sessions (ADR 0017). The files are the
 * source of truth and every engine watches them, so sessions on the shared
 * daemon and in private engines all see one edit. A session's system prompt
 * never changes (invariant 7): a change reaches it as a reminder appended
 * with its next prompt, and new sessions start with the current text.
 */
import { createHash } from 'node:crypto';
import { type FSWatcher, statSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Message, TextPart } from '@switchback/protocol';
import { readInstructions } from './instructions.ts';
import { INSTRUCTION_HEADINGS } from './system-prompt.ts';

export type Scope = 'user' | 'project';
export type Instructions = Partial<Record<Scope, string>>;
export type InstructionHashes = Partial<Record<Scope, string>>;

const SCOPES: Scope[] = ['user', 'project'];

export function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function hashesOf(i: Instructions): InstructionHashes {
  const out: InstructionHashes = {};
  for (const scope of SCOPES) {
    const text = i[scope];
    if (text) out[scope] = hashOf(text);
  }
  return out;
}

export interface InstructionsSource {
  current(): Instructions;
  /** Re-read the files if they may have changed; the scopes whose text did. */
  refresh(): Scope[];
  /** Start watching the files, if there are files; `onChange` hears about each settled change. */
  watch?(onChange: (scopes: Scope[]) => void): void;
  close(): void;
}

/** Instructions that never change (an engine built from strings: tests, embedding). */
export function fixedInstructions(i: Instructions): InstructionsSource {
  return { current: () => i, refresh: () => [], close: () => {} };
}

/** A file's size and modification time, or `none`: cheap to compare before reading. */
function stamp(file: string): string {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return 'none';
  }
}

/**
 * Both AGENTS.md files, watched. `fs.watch` on their folders catches edits
 * (editors often save by replacing the file); `refresh()` before each prompt
 * catches what it misses on network file systems and in some containers.
 */
export class WatchedInstructions implements InstructionsSource {
  private texts: Instructions = {};
  private stamps: Partial<Record<Scope, string>> = {};
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly files: Record<Scope, string>,
    private readonly debounceMs = 200,
  ) {
    this.refresh();
  }

  current(): Instructions {
    return this.texts;
  }

  refresh(): Scope[] {
    const changed: Scope[] = [];
    for (const scope of SCOPES) {
      const now = stamp(this.files[scope]);
      if (now === this.stamps[scope]) continue;
      this.stamps[scope] = now;
      const text = readInstructions(this.files[scope]);
      if (text === this.texts[scope]) continue;
      if (text) this.texts = { ...this.texts, [scope]: text };
      else {
        const { [scope]: _, ...rest } = this.texts;
        this.texts = rest;
      }
      changed.push(scope);
    }
    return changed;
  }

  /** Start watching; `onChange` hears about each settled burst of writes. */
  watch(onChange: (scopes: Scope[]) => void): void {
    const byDir = new Map<string, string[]>();
    for (const scope of SCOPES) {
      const dir = dirname(this.files[scope]);
      byDir.set(dir, [...(byDir.get(dir) ?? []), basename(this.files[scope])]);
    }
    for (const [dir, names] of byDir) {
      try {
        const w = watch(dir, (_event, name) => {
          if (name && !names.includes(String(name))) return;
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            const changed = this.refresh();
            if (changed.length) onChange(changed);
          }, this.debounceMs);
        });
        w.unref?.();
        this.watchers.push(w);
      } catch {
        // The folder doesn't exist yet (no ~/.switchback); refresh() before each prompt still sees the file appear.
      }
    }
  }

  close(): void {
    clearTimeout(this.timer);
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}

/** What clients show when a file changes (in `config.updated`'s notes). */
export function changeNote(scope: Scope): string {
  const file = scope === 'user' ? 'Your AGENTS.md (~/.switchback)' : "The project's AGENTS.md";
  return `${file} changed; sessions get it with their next message`;
}

const NAMES: Record<Scope, string> = {
  user: "The user's AGENTS.md (their instructions for every project)",
  project: "The project's AGENTS.md",
};

/**
 * What a session's model was told: the hashes its system prompt was built
 * with, updated by every reminder since. Undefined for a session created
 * before Switchback recorded them, which is taken to be up to date.
 */
export function toldOf(
  header: InstructionHashes | undefined,
  messages: Message[],
): InstructionHashes | undefined {
  if (!header) return undefined;
  let told: InstructionHashes = { ...header };
  for (const m of messages)
    for (const p of m.parts)
      if (p.type === 'text' && p.instructions) {
        const { scope, hash } = p.instructions;
        const { [scope]: _, ...rest } = told;
        told = hash ? { ...rest, [scope]: hash } : rest;
      }
  return told;
}

/** Reminders for whatever changed since the model was `told`; empty when nothing did. */
export function instructionReminders(told: InstructionHashes, now: Instructions): TextPart[] {
  const parts: TextPart[] = [];
  for (const scope of SCOPES) {
    const text = now[scope];
    const hash = text ? hashOf(text) : undefined;
    if (hash === told[scope]) continue;
    const heading = INSTRUCTION_HEADINGS[scope];
    parts.push({
      type: 'text',
      text: text
        ? `${NAMES[scope]} changed. These instructions replace the "${heading}" section of your system prompt:\n\n${text.trim()}`
        : `${NAMES[scope]} was removed. Disregard the "${heading}" section of your system prompt.`,
      reminder: true,
      instructions: { scope, ...(hash ? { hash } : {}) },
    });
  }
  return parts;
}

/**
 * The latest instruction reminder of each scope among `messages`, so
 * compaction can carry them past its summary: the model must keep following
 * instructions it was given after its system prompt was written.
 */
export function latestInstructionReminders(messages: Message[]): TextPart[] {
  const latest: Partial<Record<Scope, TextPart>> = {};
  for (const m of messages)
    for (const p of m.parts)
      if (p.type === 'text' && p.instructions) latest[p.instructions.scope] = p;
  return SCOPES.flatMap((s) => (latest[s] ? [latest[s]] : []));
}
