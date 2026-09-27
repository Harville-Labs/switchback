/**
 * Pure editing logic for the prompt input: a string plus a cursor offset.
 * Kept free of Ink so it can be unit-tested.
 */
import { Fzf } from 'fzf';

export interface EditorState {
  value: string;
  cursor: number;
}

export const empty: EditorState = { value: '', cursor: 0 };

export function at(value: string): EditorState {
  return { value, cursor: value.length };
}

export function insert(s: EditorState, text: string): EditorState {
  // Normalize pasted CRLF / CR to LF.
  const t = text.replace(/\r\n?/g, '\n');
  return {
    value: s.value.slice(0, s.cursor) + t + s.value.slice(s.cursor),
    cursor: s.cursor + t.length,
  };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * Cursor offset one user-perceived character away, so emoji, flags, and
 * combining accents are never split into invalid halves.
 */
function step(value: string, cursor: number, dir: -1 | 1): number {
  if (dir < 0) {
    if (cursor <= 0) return 0;
    let prev = 0;
    for (const { index } of graphemes.segment(value.slice(0, cursor))) prev = index;
    return prev;
  }
  if (cursor >= value.length) return value.length;
  const first = graphemes.segment(value.slice(cursor))[Symbol.iterator]().next().value;
  return cursor + (first?.segment.length ?? 1);
}

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  const from = step(s.value, s.cursor, -1);
  return { value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.value.length) return s;
  const to = step(s.value, s.cursor, 1);
  return { value: s.value.slice(0, s.cursor) + s.value.slice(to), cursor: s.cursor };
}

/** Delete the word before the cursor (ctrl+w). */
export function deleteWord(s: EditorState): EditorState {
  const before = s.value.slice(0, s.cursor);
  const start = before.replace(/\s+$/, '').search(/\S+$/);
  const from = start === -1 ? 0 : start;
  return { value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from };
}

/** Delete from the start of the current line to the cursor (ctrl+u). */
export function deleteToLineStart(s: EditorState): EditorState {
  const from = s.value.lastIndexOf('\n', s.cursor - 1) + 1;
  return { value: s.value.slice(0, from) + s.value.slice(s.cursor), cursor: from };
}

export function moveHorizontal(s: EditorState, delta: number): EditorState {
  let cursor = s.cursor;
  for (let i = 0; i < Math.abs(delta); i++) cursor = step(s.value, cursor, delta < 0 ? -1 : 1);
  return { ...s, cursor };
}

export function lineStart(s: EditorState): EditorState {
  return { ...s, cursor: s.value.lastIndexOf('\n', s.cursor - 1) + 1 };
}

export function lineEnd(s: EditorState): EditorState {
  const nl = s.value.indexOf('\n', s.cursor);
  return { ...s, cursor: nl === -1 ? s.value.length : nl };
}

/** Line and column of the cursor. */
export function position(s: EditorState): { line: number; column: number; lines: string[] } {
  const lines = s.value.split('\n');
  let remaining = s.cursor;
  for (let line = 0; line < lines.length; line++) {
    const len = (lines[line] ?? '').length;
    if (remaining <= len) return { line, column: remaining, lines };
    remaining -= len + 1;
  }
  return { line: lines.length - 1, column: (lines.at(-1) ?? '').length, lines };
}

/**
 * Move the cursor up or down a line. Returns undefined at the first/last
 * line, which the input uses to switch to history navigation instead.
 */
export function moveVertical(s: EditorState, delta: -1 | 1): EditorState | undefined {
  const { line, column, lines } = position(s);
  const target = line + delta;
  if (target < 0 || target >= lines.length) return undefined;
  let offset = 0;
  for (let i = 0; i < target; i++) offset += (lines[i] ?? '').length + 1;
  return { ...s, cursor: offset + Math.min(column, (lines[target] ?? '').length) };
}

// ---------------------------------------------------------------------------
// @file mentions
// ---------------------------------------------------------------------------

/** The `@token` the cursor is in, if any. */
export function mentionAt(s: EditorState): { start: number; query: string } | undefined {
  const before = s.value.slice(0, s.cursor);
  const match = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return undefined;
  const query = match[2] ?? '';
  return { start: s.cursor - query.length - 1, query };
}

/** Replace the mention under the cursor with `@path ` . */
export function completeMention(s: EditorState, path: string): EditorState {
  const m = mentionAt(s);
  if (!m) return s;
  const text = `@${path} `;
  return {
    value: s.value.slice(0, m.start) + text + s.value.slice(s.cursor),
    cursor: m.start + text.length,
  };
}

const finders = new WeakMap<string[], Fzf<string[]>>();

const stem = (p: string) =>
  p
    .slice(p.lastIndexOf('/') + 1)
    .replace(/\.[^.]*$/, '')
    .toLowerCase();

/**
 * Rank paths for a query with fzf's algorithm (word-boundary and path-segment
 * bonuses). Equal scores prefer an exact file name (`main` → `main.ts` over
 * `main-notes.md`), then shorter paths. The finder is cached per file list so
 * each keystroke doesn't rebuild it.
 */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit);
  let fzf = finders.get(files);
  if (!fzf) {
    fzf = new Fzf(files, { casing: 'case-insensitive' });
    finders.set(files, fzf);
  }
  const q = query.toLowerCase();
  const exact = (p: string) => Number(stem(p) === q);
  return fzf
    .find(query)
    .sort(
      (a, b) => b.score - a.score || exact(b.item) - exact(a.item) || a.item.length - b.item.length,
    )
    .slice(0, limit)
    .map((r) => r.item);
}
