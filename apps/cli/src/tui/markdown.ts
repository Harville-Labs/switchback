/**
 * Markdown to ANSI for finished assistant messages. Streaming text stays plain
 * so half-written Markdown never flickers; committed items render once.
 */
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

const renderers = new Map<number, Marked>();
const cache = new Map<string, string>();

export function renderMarkdown(text: string, width: number): string {
  const key = `${width}\u0000${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let marked = renderers.get(width);
  if (!marked) {
    // The typings lag marked's extension API; the runtime shape matches.
    marked = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }) as never);
    renderers.set(width, marked);
  }
  let out: string;
  try {
    out = (marked.parse(text) as string).replace(/\n+$/, '');
  } catch {
    out = text; // never lose the answer over a rendering problem
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}
