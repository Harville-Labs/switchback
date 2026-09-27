/**
 * Pure editing logic for the prompt input: a string plus a cursor offset.
 * Kept free of Ink so it can be unit-tested.
 */

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

export function backspace(s: EditorState): EditorState {
  if (s.cursor === 0) return s;
  return { value: s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), cursor: s.cursor - 1 };
}

export function deleteForward(s: EditorState): EditorState {
  if (s.cursor >= s.value.length) return s;
  return { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor };
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
  return { ...s, cursor: Math.max(0, Math.min(s.value.length, s.cursor + delta)) };
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

/**
 * Rank paths for a query: subsequence match, preferring matches in the file
 * name, contiguous runs, and shorter paths.
 */
export function rankFiles(files: string[], query: string, limit = 8): string[] {
  if (!query) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const p = path.toLowerCase();
    let score = 0;
    let pi = 0;
    let run = 0;
    for (const ch of q) {
      const found = p.indexOf(ch, pi);
      if (found === -1) {
        score = -1;
        break;
      }
      run = found === pi ? run + 1 : 0;
      score += 1 + run * 2;
      pi = found + 1;
    }
    if (score < 0) continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (name.replace(/\.[^.]*$/, '') === q) score += 30;
    if (name.includes(q)) score += 20;
    if (name.startsWith(q)) score += 10;
    score -= path.length * 0.05;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.path);
}
