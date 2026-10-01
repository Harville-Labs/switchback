/**
 * Known hosted models, grouped by provider. Used by `switchback init` to offer
 * choices and by pricing to cost usage. Every provider is described the same
 * way; none is a default. Anything not listed still works when configured by
 * hand, and prices can be overridden per model in config.
 *
 * Sizes map to the model aliases agents use: `large` -> `opus`, `medium` ->
 * `sonnet`, `small` -> `haiku` (the names come from Claude Code agent files,
 * but they mean "tier" for every provider).
 *
 * Prices are USD per million tokens, list price, checked 2026-09-26 (Gemini:
 * 2026-09-27, ai.google.dev/gemini-api/docs/pricing; Pro prices are for prompts
 * up to 200k tokens).
 */
import type { Price } from './pricing.ts';

export type ModelSize = 'large' | 'medium' | 'small';

export interface CatalogModel {
  id: string;
  label: string;
  size: ModelSize;
  contextWindow: number;
  maxOutputTokens: number;
  price: Price;
  note?: string;
}

export type HostedProviderKind = 'anthropic' | 'openai' | 'deepseek' | 'gemini';

export const CATALOG: Record<HostedProviderKind, { label: string; models: CatalogModel[] }> = {
  anthropic: {
    label: 'Anthropic (Claude)',
    models: [
      {
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        size: 'large',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_000,
        price: { input: 5, output: 25 },
      },
      {
        id: 'claude-sonnet-5',
        label: 'Claude Sonnet 5',
        size: 'medium',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_000,
        price: { input: 2, output: 10 },
      },
      {
        id: 'claude-haiku-4-5',
        label: 'Claude Haiku 4.5',
        size: 'small',
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
        price: { input: 1, output: 5 },
      },
    ],
  },
  openai: {
    label: 'OpenAI',
    models: [
      {
        id: 'gpt-6-astra',
        label: 'GPT-6 Astra',
        size: 'large',
        contextWindow: 1_050_000,
        maxOutputTokens: 32_000,
        price: { input: 10, output: 50, cacheRead: 1 },
      },
      {
        id: 'gpt-6-sol',
        label: 'GPT-6 Sol',
        size: 'medium',
        contextWindow: 1_050_000,
        maxOutputTokens: 32_000,
        price: { input: 2, output: 10, cacheRead: 0.2 },
      },
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        size: 'small',
        contextWindow: 1_050_000,
        maxOutputTokens: 16_000,
        price: { input: 0.1, output: 0.5, cacheRead: 0.01 },
      },
    ],
  },
  deepseek: {
    label: 'DeepSeek',
    models: [
      // Peak-hour prices; off-peak is half. Costs are therefore upper bounds.
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        size: 'large',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_000,
        price: { input: 1.32, output: 3.96, cacheRead: 0.044 },
        note: 'peak-hour price',
      },
      {
        id: 'deepseek-flash',
        label: 'DeepSeek V4.1 Flash',
        size: 'small',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_000,
        price: { input: 0.3, output: 1.2, cacheRead: 0.006 },
        note: 'peak-hour price',
      },
    ],
  },
  gemini: {
    label: 'Google Gemini',
    models: [
      {
        id: 'gemini-3.1-pro-preview',
        label: 'Gemini 3.1 Pro (preview)',
        size: 'large',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        price: { input: 2, output: 12, cacheRead: 0.2 },
        note: 'doubles above 200k-token prompts',
      },
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        size: 'medium',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        price: { input: 0.75, output: 3.75, cacheRead: 0.075 },
        note: 'introductory price through 2026; $1.50 / $7.50 from 2027',
      },
      {
        id: 'gemini-2.5-flash',
        label: 'Gemini 2.5 Flash',
        size: 'small',
        contextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        price: { input: 0.3, output: 2.5, cacheRead: 0.03 },
      },
    ],
  },
};

/** The model for each alias, per provider: the listed size, or the nearest larger one. */
export function aliasModels(
  kind: HostedProviderKind,
): Record<'opus' | 'sonnet' | 'haiku', CatalogModel> {
  const models = CATALOG[kind].models;
  const pick = (...sizes: ModelSize[]) => {
    for (const size of sizes) {
      const m = models.find((x) => x.size === size);
      if (m) return m;
    }
    return models[0] as CatalogModel;
  };
  return {
    opus: pick('large', 'medium', 'small'),
    sonnet: pick('medium', 'large', 'small'),
    haiku: pick('small', 'medium', 'large'),
  };
}

export function catalogPrices(): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const { models } of Object.values(CATALOG)) for (const m of models) out[m.id] = m.price;
  return out;
}
