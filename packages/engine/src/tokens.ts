/**
 * Prompt token counts for routing and cost estimates.
 *
 * The baseline is a real BPE tokenizer (o200k). No single tokenizer matches
 * every model, but on code it's far closer than a characters-per-token guess.
 * Near the local context threshold, where the answer decides local vs. remote,
 * the engine asks the local server for an exact count instead.
 */
import type { Message } from '@harness/protocol';
import { countTokens as bpeCount } from 'gpt-tokenizer';

/**
 * BPE merging is quadratic in the length of one pre-token, and long runs
 * without whitespace (minified code, base64, pasted logs) are a single
 * pre-token: 200k characters took 12 s. Counting fixed-size chunks keeps it
 * linear, at the cost of at most one extra token per chunk (about 0.2%).
 */
const CHUNK = 2_000;

export function countTokens(text: string): number {
  if (text.length <= CHUNK) return bpeCount(text);
  let n = 0;
  for (let i = 0; i < text.length; i += CHUNK) n += bpeCount(text.slice(i, i + CHUNK));
  return n;
}

/** Role markers and separators a chat template adds per message. */
export const PER_MESSAGE_OVERHEAD = 4;

/** Transcripts are append-only, so a message's count never changes. */
const messageCache = new WeakMap<Message, number>();
const textCache = new Map<string, number>();

/** The text a count covers: everything the model reads, in order. */
export function messageText(m: Message): string {
  return m.parts
    .map((p) => {
      if (p.type === 'text' || p.type === 'reasoning') return p.text;
      if (p.type === 'tool_result') return p.content;
      return `${p.name} ${JSON.stringify(p.input ?? {})}`;
    })
    .join('\n');
}

export function messageTokens(m: Message): number {
  let n = messageCache.get(m);
  if (n === undefined) {
    n = countTokens(messageText(m)) + PER_MESSAGE_OVERHEAD;
    messageCache.set(m, n);
  }
  return n;
}

/** For the system prompt and tool schemas, which repeat on every call of a session. */
function textTokens(text: string): number {
  let n = textCache.get(text);
  if (n === undefined) {
    n = countTokens(text);
    if (textCache.size > 64) textCache.clear();
    textCache.set(text, n);
  }
  return n;
}

export function promptTokens(system: string, messages: Message[], toolsJson: string): number {
  let n = textTokens(system) + textTokens(toolsJson);
  for (const m of messages) n += messageTokens(m);
  return n;
}

/** The same content as one string, for a server-side exact count. */
export function promptText(system: string, messages: Message[], toolsJson: string): string {
  return [system, toolsJson, ...messages.map(messageText)].join('\n');
}

/** Within this fraction of the threshold, an estimate isn't trusted to decide. */
export const NEAR_THRESHOLD = 0.2;

export function nearThreshold(estimate: number, threshold: number): boolean {
  return Math.abs(estimate - threshold) <= threshold * NEAR_THRESHOLD;
}
