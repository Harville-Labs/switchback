import type { Usage } from '@harness/protocol';

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * First-party Claude API list prices. Bedrock and Vertex bill separately; users
 * override per model in config (`models.<alias>.price`). Local models cost 0.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** Look up a price, tolerating platform prefixes such as Bedrock's `anthropic.`. */
export function priceFor(model: string, overrides: Record<string, Price> = {}): Price | undefined {
  const bare = model.replace(/^(?:[a-z]+\.)?anthropic\./, '');
  return overrides[model] ?? overrides[bare] ?? DEFAULT_PRICES[model] ?? DEFAULT_PRICES[bare];
}

export function costUsd(usage: Usage, price: Price | undefined): number {
  if (!price) return 0;
  // Cache writes default to 1.25x input (5-minute TTL); reads to 0.1x input.
  const cacheRead = price.cacheRead ?? price.input * 0.1;
  const cacheWrite = price.cacheWrite ?? price.input * 1.25;
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWriteTokens ?? 0) * cacheWrite) /
    1_000_000
  );
}
