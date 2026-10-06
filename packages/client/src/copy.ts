/**
 * What `/copy` copies, the same in both clients: the raw text, never the
 * rendering (no wrapping, gutters, or syntax colors).
 */
import { Lexer } from 'marked';
import { transcriptMarkdown } from './format.ts';
import type { ViewItem } from './view.ts';

/** The raw text of each fenced or indented code block, in order. */
export function codeBlocks(markdown: string): string[] {
  return new Lexer()
    .lex(markdown)
    .flatMap((t) => (t.type === 'code' ? [(t as { text: string }).text] : []));
}

/**
 * What `/copy [arg]` copies: the last reply, its code block `n` (1-based),
 * the last tool's output (`tool`), or the whole conversation as Markdown (`all`).
 */
export function pickCopy(
  items: readonly ViewItem[],
  arg: string | undefined,
): { text: string; what: string } | { error: string } {
  if (arg === 'all') {
    const text = transcriptMarkdown(items);
    return text ? { text, what: 'the conversation' } : { error: 'nothing to copy yet' };
  }
  if (arg === 'tool') {
    const tool = items.findLast((it) => it.kind === 'tool' && it.output);
    return tool?.kind === 'tool' && tool.output
      ? { text: tool.output, what: `the output of ${tool.name}` }
      : { error: 'no tool output yet' };
  }
  const last = items.findLast((it) => it.kind === 'assistant' && it.text);
  if (last?.kind !== 'assistant') return { error: 'nothing to copy yet' };
  const reply = last.text;
  if (!arg) return { text: reply, what: 'the last reply' };
  const blocks = codeBlocks(reply);
  if (!blocks.length) return { error: 'the last reply has no code blocks; /copy copies all of it' };
  const n = arg === 'code' ? 1 : Number(arg);
  if (!/^\d+$/.test(arg) && arg !== 'code')
    return { error: 'usage: /copy [n | code | tool | all]' };
  if (!Number.isInteger(n) || n < 1 || n > blocks.length)
    return {
      error: `the last reply has ${blocks.length} code block${blocks.length === 1 ? '' : 's'}: /copy 1${blocks.length > 1 ? `…${blocks.length}` : ''}`,
    };
  return { text: blocks[n - 1] as string, what: `code block ${n} of ${blocks.length}` };
}
