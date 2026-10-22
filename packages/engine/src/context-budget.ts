/**
 * How much of a model's context window one piece of new content may fill.
 * Fixed character limits suit a 200k-token model and swamp an 8k local one:
 * a single 30,000-character read is most of its window. Scaling to the window
 * keeps a turn on the model it started on instead of forcing an escalation or
 * an overflow.
 */

/**
 * Characters per token, on the low side of what code and prose tokenize to,
 * so a budget in characters doesn't overshoot its share of tokens.
 */
export const CHARS_PER_TOKEN = 3;

/** Share of the window all of one step's tool results may fill together. */
export const RESULT_SHARE = 0.25;

/** Share of the window a prompt's `@` mentions and attachments may fill together. */
export const ATTACHMENT_SHARE = 0.5;

/** No result is cut below this, however small the window or many the calls. */
export const MIN_RESULT_CHARS = 2_000;

/**
 * Characters each of `calls` tool results from one step may keep, given the
 * context window of the model that made the calls. Never more than `ceiling`,
 * the limit that applies whatever the window.
 */
export function resultChars(window: number, calls: number, ceiling: number): number {
  const share = (window * RESULT_SHARE * CHARS_PER_TOKEN) / Math.max(1, calls);
  return Math.min(ceiling, Math.max(MIN_RESULT_CHARS, Math.floor(share)));
}

/**
 * Characters a prompt's attachments may add in total. `window` is the window
 * the session is kept inside; unknown means only `ceiling` applies.
 */
export function attachmentChars(window: number | undefined, ceiling: number): number {
  if (!window) return ceiling;
  return Math.min(ceiling, Math.floor(window * ATTACHMENT_SHARE * CHARS_PER_TOKEN));
}

/**
 * `text` cut to `max` characters, keeping its start and its last few lines:
 * results end with what says how they ended (a command's exit code, how many
 * lines a read left out, that a search hit its limit). `note` says how to get
 * the rest.
 */
export function fitResult(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const tail = Math.min(2_000, Math.floor(max / 5));
  const cut = text.length - max;
  return `${text.slice(0, max - tail)}\n\n[${cut} characters left out here; ${note}]\n\n${text.slice(text.length - tail)}`;
}
