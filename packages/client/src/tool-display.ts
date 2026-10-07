/**
 * How a tool call reads in a transcript: a title (`Read a.txt`), one line on
 * what it did (`42 lines`), a few lines of a command's output, and the size
 * of an edit. Shared by both clients, so the TUI and VS Code tell the same
 * story; each draws it its own way.
 */
import type { ViewItem } from './view-state.ts';

type ToolItem = Extract<ViewItem, { kind: 'tool' }>;

export interface ToolTitle {
  /** What the call does: `Read`, `Bash`, `Update`, `Search`. */
  verb: string;
  /** What it does it to: a path, a command, a pattern. */
  target: string;
}

const str = (input: unknown, ...keys: string[]): string | undefined => {
  const i = (input ?? {}) as Record<string, unknown>;
  return keys.map((k) => i[k]).find((v): v is string => typeof v === 'string');
};

export function toolTitle(name: string, input: unknown): ToolTitle {
  // Coding agent CLIs (Claude Code) name tools `Bash`, `Edit`, … with `file_path`.
  const path = str(input, 'path', 'file_path') ?? '';
  switch (name.toLowerCase()) {
    case 'bash':
      return { verb: 'Bash', target: str(input, 'command') ?? '' };
    case 'read':
      return { verb: 'Read', target: path };
    case 'edit':
    case 'multiedit':
      return { verb: 'Update', target: path };
    case 'write':
      return { verb: 'Write', target: path };
    case 'glob':
      return { verb: 'List', target: str(input, 'pattern') ?? '' };
    case 'grep': {
      const where = str(input, 'path');
      return {
        verb: 'Search',
        target: `"${str(input, 'pattern') ?? ''}"${where ? ` in ${where}` : ''}`,
      };
    }
    case 'webfetch':
      return { verb: 'Fetch', target: str(input, 'url') ?? '' };
    case 'websearch':
      return { verb: 'Web search', target: str(input, 'query') ?? '' };
    case 'bash_output':
      return { verb: 'Shell output', target: str(input, 'id') ?? '' };
    case 'kill_shell':
      return { verb: 'Stop shell', target: str(input, 'id') ?? '' };
    case 'skill':
      return { verb: 'Skill', target: str(input, 'name') ?? '' };
    case 'exit_plan_mode':
      return { verb: 'Plan', target: '' };
  }
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    return {
      verb: `${server} · ${tool}`,
      target: str(input, 'path', 'url', 'query', 'name') ?? '',
    };
  }
  return { verb: name, target: str(input, 'path', 'file_path', 'pattern', 'url', 'query') ?? '' };
}

export interface DiffStats {
  added: number;
  removed: number;
  /** The file didn't exist before (`@@ -0,0 …`). */
  created: boolean;
}

export function diffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed, created: /^@@ -0,0 /m.test(diff) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ToolResult {
  /** One line on what the call did; undefined while it runs or when there's nothing to say. */
  summary?: string;
  /** Lines of output worth showing under it (a command's), at most `maxLines`. */
  body: string[];
  /** Output lines left out of `body`. */
  more: number;
  tone: 'ok' | 'error' | 'muted';
}

/** What a finished call did, in a line or a few. */
export function toolResult(item: ToolItem, maxLines = 3): ToolResult {
  const none: ToolResult = { body: [], more: 0, tone: 'muted' };
  if (item.status === 'running') return none;
  const output = item.output ?? '';
  if (item.denied)
    return {
      ...none,
      summary: firstLine(output).startsWith('The user declined this and said')
        ? 'Declined, with a note for the model'
        : 'Not run: declined',
    };
  if (item.status === 'error')
    return { ...none, summary: firstLine(output) || 'Failed', tone: 'error' };
  const name = item.name.toLowerCase();
  if (name === 'bash') return bashResult(output, maxLines);
  if ((name === 'edit' || name === 'write') && item.diff) {
    const s = diffStats(item.diff);
    const summary = s.created
      ? `Wrote ${plural(s.added, 'line')}`
      : s.added || s.removed
        ? `${plural(s.added, 'addition')}, ${plural(s.removed, 'removal')}`
        : 'No changes';
    return { ...none, summary, tone: 'ok' };
  }
  return { ...none, summary: summaryOf(name, output), tone: 'ok' };
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  );
}

function summaryOf(name: string, output: string): string | undefined {
  const lines = output.split('\n').filter((l) => l.trim());
  switch (name) {
    case 'read': {
      if (/: (PNG|JPEG|GIF|WEBP) image$/.test(output)) return 'Image';
      const all = output.split('\n').filter((l) => /^\s*\d+\t/.test(l));
      // A file that ends in a newline reads back with an empty last line; people don't count it.
      if (all.length > 1 && /^\s*\d+\t$/.test(all.at(-1) ?? '')) all.pop();
      const numbered = all.length;
      const more = /\[(\d+) more lines\]/.exec(output)?.[1];
      return `${plural(numbered, 'line')}${more ? ` of ${numbered + Number(more)}` : ''}`;
    }
    case 'glob':
      return output.trim() === 'no matches' ? 'No files' : plural(lines.length, 'file');
    case 'grep': {
      if (output.trim() === 'no matches') return 'No matches';
      const hits = lines.filter((l) => /^.+?:\d+: /.test(l));
      const files = new Set(hits.map((l) => /^(.+?):\d+: /.exec(l)?.[1]));
      const capped = output.includes('[result limit reached]') ? '+' : '';
      return `${plural(hits.length, 'match', 'matches')}${capped} in ${plural(files.size, 'file')}`;
    }
    case 'webfetch':
      return `${plural(lines.length, 'line')} of text`;
  }
  const first = firstLine(output);
  return first.length > 120 ? `${first.slice(0, 119)}…` : first || undefined;
}

/** A command's output: what it printed, and its exit code when that's news. */
function bashResult(output: string, maxLines: number): ToolResult {
  if (output.startsWith('started background shell'))
    return { summary: 'Running in the background', body: [], more: 0, tone: 'ok' };
  const code = /\nexit code: (.+)$|^exit code: (.+)$/.exec(output);
  const exit = (code?.[1] ?? code?.[2] ?? '0').trim();
  const printed = output
    .replace(/(^|\n)exit code: .+$/, '')
    .replace(/^stdout:\n/, '')
    .replace(/\nstderr:\n/, '\n')
    .replace(/^stderr:\n/, '')
    .split('\n')
    .filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1));
  while (printed.at(-1)?.trim() === '') printed.pop();
  const failed = exit !== '0';
  const summary = failed
    ? /^\d+$/.test(exit)
      ? `Exit code ${exit}`
      : exit
    : printed.length
      ? undefined
      : 'No output';
  return {
    ...(summary ? { summary } : {}),
    body: printed.slice(0, maxLines),
    more: Math.max(0, printed.length - maxLines),
    tone: failed ? 'error' : 'ok',
  };
}

/** Calls that only look around; runs of them read better as one block. */
const EXPLORING = new Set(['read', 'glob', 'grep']);

export type DisplayRow =
  | { kind: 'item'; item: ViewItem }
  | { kind: 'explore'; id: string; calls: ToolItem[] };

/**
 * The transcript as rows to draw: two or more read, list, and search calls in
 * a row become one "Explored" block. A failed or refused call stays on its own,
 * since it's news.
 */
export function displayRows(items: readonly ViewItem[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= 2) rows.push({ kind: 'explore', id: run[0]?.id ?? '', calls: run });
    else for (const item of run) rows.push({ kind: 'item', item });
    run = [];
  };
  for (const item of items) {
    const exploring =
      item.kind === 'tool' && EXPLORING.has(item.name) && item.status !== 'error' && !item.denied;
    if (exploring) run.push(item);
    else {
      flush();
      rows.push({ kind: 'item', item });
    }
  }
  flush();
  return rows;
}

/** An "Explored" block's headline: `3 files read · 2 searches`. */
export function exploreSummary(calls: readonly ToolItem[]): string {
  const count = (name: string) => calls.filter((c) => c.name === name).length;
  const parts = [
    count('read') ? `read ${plural(count('read'), 'file')}` : '',
    count('grep') ? plural(count('grep'), 'search', 'searches') : '',
    count('glob') ? plural(count('glob'), 'listing') : '',
  ].filter(Boolean);
  return parts.join(' · ');
}
