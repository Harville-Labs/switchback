/** Below this many output tokens, a rate mostly measures latency; it isn't reported. */
const MIN_TOKENS_FOR_SPEED = 16;
/**
 * Below this much decoding time, a rate measures timer noise: an answer that arrives in one
 * chunk (a mock, a cached reply) decodes in a millisecond or two and reads as 500k tok/s.
 */
const MIN_MS_FOR_SPEED = 50;

/** A call's output and speed, from when it started, first streamed, and ended (ms). */
export function callSpeed(
  outputTokens: number,
  started: number,
  firstToken: number | undefined,
  ended: number,
): { outputTokens: number; tokensPerSecond?: number; firstTokenMs?: number; decodeMs?: number } {
  // Decoding speed: from the first token, so the prompt's processing time doesn't count.
  const ms = ended - (firstToken ?? started);
  return {
    outputTokens,
    ...(outputTokens >= MIN_TOKENS_FOR_SPEED && ms >= MIN_MS_FOR_SPEED
      ? {
          tokensPerSecond: Math.round((outputTokens / ms) * 10_000) / 10,
          decodeMs: Math.round(ms),
        }
      : {}),
    ...(firstToken !== undefined ? { firstTokenMs: Math.round(firstToken - started) } : {}),
  };
}
