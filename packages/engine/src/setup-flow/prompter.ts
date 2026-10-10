/**
 * What setup needs from whoever asks the questions: the terminal for
 * `switchback init`, or a client over the protocol (protocol-prompter.ts).
 * Questions are plain text; context goes in notes, which each client draws
 * its own way.
 */
import type { SetupNote } from '@switchback/protocol';

export interface SetupChoice<T> {
  label: string;
  value: T;
  hint?: string;
  /** Multi-select only: ticked to begin with. */
  checked?: boolean;
}

export interface SetupPrompter {
  text(question: string, fallback?: string): Promise<string>;
  number(question: string, fallback?: number): Promise<number | undefined>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  select<T>(question: string, options: SetupChoice<T>[], defaultIndex?: number): Promise<T>;
  multiSelect<T>(question: string, options: SetupChoice<T>[]): Promise<T[]>;
  /** One of a long list, filtered as you type; with `freeText`, what was typed can be the answer. */
  search(
    question: string,
    options: SetupChoice<string>[],
    opts?: { freeText?: boolean },
  ): Promise<string>;
  note(note: SetupNote): void;
}

/** Shorthands for the common notes. */
export const say = (
  p: SetupPrompter | undefined,
  text: string,
  tone?: 'detail' | 'warning' | 'success' | 'heading',
) => p?.note({ kind: 'text', text, ...(tone ? { tone } : {}) });

const notesOnly = new WeakSet<SetupPrompter>();

/** Unattended setup (`--yes`): nothing is asked, but notes still reach the person. */
export function unattended(note: (note: SetupNote) => void): SetupPrompter {
  const never = (): never => {
    throw new Error('unattended setup asked a question; a flag should have answered it');
  };
  const ui: SetupPrompter = {
    text: never,
    number: never,
    confirm: never,
    select: never,
    multiSelect: never,
    search: never,
    note,
  };
  notesOnly.add(ui);
  return ui;
}

/** Who can answer questions: the prompter, or nobody when setup runs unattended. */
export function asking(ui: SetupPrompter | undefined): SetupPrompter | undefined {
  return ui && !notesOnly.has(ui) ? ui : undefined;
}
