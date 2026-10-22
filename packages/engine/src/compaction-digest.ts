/**
 * The parts of compaction that need no model (ADR 0026): which tool output a
 * later call made stale, a record of the compacted history kept word for
 * word, and how the summarizer's calls are planned. A summary written by a
 * small local model loses things; the record keeps what must survive it.
 */
import type { Message } from '@switchback/protocol';
import { countTokens } from './tokens.ts';

const pathOf = (input: unknown): string | undefined => {
  const path = (input as { path?: unknown } | null)?.path;
  return typeof path === 'string' ? path : undefined;
};

/**
 * Tool calls whose output a later call superseded: the same call made again,
 * or a read of a file that was read, written, or edited afterwards. Their
 * output is left out of what the summarizer reads.
 */
export function staleCalls(messages: Message[]): Set<string> {
  const stale = new Set<string>();
  const seen = new Set<string>();
  const touched = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = (messages[i] as Message).parts;
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p?.type !== 'tool_call') continue;
      const key = `${p.name} ${JSON.stringify(p.input ?? {})}`;
      const path = pathOf(p.input);
      if (seen.has(key) || (p.name === 'read' && path && touched.has(path))) stale.add(p.id);
      seen.add(key);
      if (path && (p.name === 'read' || p.name === 'write' || p.name === 'edit')) touched.add(path);
    }
  }
  return stale;
}

export const RECORD_HEADING = '## Record';
const REQUEST_CHARS = 300;
const MAX_REQUESTS = 12;
const MAX_FILES = 40;
const MAX_FAILURES = 8;

const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n).trimEnd()}…` : text;
const lastUnique = (items: string[], n: number) =>
  [...new Set([...items].reverse())].slice(0, n).reverse();

/**
 * What happened in `messages`, taken straight from the transcript: the
 * user's requests, the files changed and read, and the commands that failed.
 * Empty when there's nothing to record.
 */
export function historyRecord(messages: Message[]): string {
  const requests: string[] = [];
  const changed: string[] = [];
  const read: string[] = [];
  const failed: string[] = [];
  const commands = new Map<string, string>();
  for (const m of messages)
    for (const p of m.parts) {
      if (m.role === 'user' && p.type === 'text' && !p.attachment && p.text.trim())
        requests.push(clip(p.text.trim().replaceAll('\n', ' '), REQUEST_CHARS));
      if (p.type === 'tool_call') {
        const path = pathOf(p.input);
        if (path && (p.name === 'write' || p.name === 'edit')) changed.push(path);
        if (path && p.name === 'read') read.push(path);
        const command = (p.input as { command?: unknown } | null)?.command;
        if (p.name === 'bash' && typeof command === 'string') commands.set(p.id, command);
      }
      if (p.type === 'tool_result' && p.isError && commands.has(p.callId))
        failed.push(clip(commands.get(p.callId) as string, 120));
    }
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    if (items.length) lines.push(`${title}:`, ...items.map((i) => `- ${i}`));
  };
  section('User requests, oldest first', requests.slice(-MAX_REQUESTS));
  section('Files changed', lastUnique(changed, MAX_FILES));
  section(
    'Files read',
    lastUnique(read, MAX_FILES).filter((f) => !changed.includes(f)),
  );
  section(
    'Commands that failed',
    failed.slice(-MAX_FAILURES).map((c) => `\`${c}\``),
  );
  return lines.length
    ? `${RECORD_HEADING} (from the transcript, word for word)\n${lines.join('\n')}`
    : '';
}

/** A summary without its record, which is rebuilt from the transcript each time. */
export function withoutRecord(summary: string): string {
  const at = summary.indexOf(`\n${RECORD_HEADING} `);
  return at >= 0 ? summary.slice(0, at).trimEnd() : summary;
}

/**
 * Rendered history in chunks of at most `budget` tokens, in order. A block
 * bigger than the budget is cut to fit rather than dropped.
 */
export function chunkBlocks(blocks: string[], budget: number): string[] {
  const chunks: string[] = [];
  let chunk: string[] = [];
  let tokens = 0;
  for (const block of blocks) {
    const full = countTokens(block);
    const n = Math.min(full, budget);
    const text = full > budget ? `${block.slice(0, budget * 3)}\n... (truncated)` : block;
    if (chunk.length && tokens + n > budget) {
      chunks.push(chunk.join('\n\n'));
      chunk = [];
      tokens = 0;
    }
    chunk.push(text);
    tokens += n;
  }
  if (chunk.length) chunks.push(chunk.join('\n\n'));
  return chunks;
}

/** `items` in consecutive groups of `size`. */
export function groupsOf<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/** How many merge calls fold `n` summaries into one, `size` at a time. */
export function mergeCalls(n: number, size: number): number {
  let calls = 0;
  let level = n;
  while (level > 1) {
    const groups = groupsOf(Array.from({ length: level }), size);
    calls += groups.filter((g) => g.length > 1).length;
    level = groups.length;
  }
  return calls;
}

export function partRequest(part: number, parts: number, chunk: string): string {
  return `This is part ${part} of ${parts} of one conversation, in order. Summarize this part on its own; another step joins the parts.\n\n${chunk}`;
}

export function mergeRequest(summaries: string[]): string {
  const body = summaries.map((s, i) => `<part n="${i + 1}">\n${s}\n</part>`).join('\n\n');
  return `These summarize consecutive parts of one conversation, oldest first. Merge them into one summary. Where they disagree, the later part is current; keep every open problem and next step from the last part.\n\n${body}`;
}
