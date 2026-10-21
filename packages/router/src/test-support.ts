/** Models, routers, and inputs shared by the router tests. */
import { RoutingConfig } from './config.ts';
import { type ModelInfo, type RouteInput, Router } from './router.ts';
import { SignalTracker } from './signals.ts';

export const model = (
  alias: string,
  tier: 'local' | 'remote',
  contextWindow: number,
  available = true,
): ModelInfo => ({
  alias,
  ref: { provider: tier === 'local' ? 'ollama' : 'cloud', model: alias },
  tier,
  contextWindow,
  available,
});

/** fast (local 32k) → large (local 128k) → opus (remote 1M); sonnet and haiku are spare remotes. */
export const MODELS: Record<string, ModelInfo> = {
  fast: model('fast', 'local', 32_000),
  large: model('large', 'local', 128_000),
  opus: model('opus', 'remote', 1_000_000),
  sonnet: model('sonnet', 'remote', 400_000),
  haiku: model('haiku', 'remote', 200_000),
};

export const LADDER = { current: ['fast'], escalate: ['large', 'opus'] };

export function router(
  config: Record<string, unknown> = LADDER,
  overrides: Record<string, ModelInfo> = {},
) {
  const models = { ...MODELS, ...overrides };
  return new Router(RoutingConfig.parse(config), (alias) => models[alias]);
}

export const signals = (extra: Partial<RouteInput['signals']> = {}) => ({
  ...new SignalTracker(RoutingConfig.parse({}).escalation).snapshot(),
  ...extra,
});

export function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    preference: 'auto',
    agent: { name: 'build', route: 'auto' },
    estimatedInputTokens: 1_000,
    signals: signals(),
    spend: { todayUsd: 0, monthUsd: 0 },
    ...overrides,
  };
}

export function routed(d: ReturnType<Router['decide']>) {
  if (d.kind !== 'route') throw new Error(`expected route, got ${d.kind}: ${d.reason}`);
  return d;
}

export const stuck = signals({ consecutiveToolErrors: 3 });
export const on = (step: number, extra: Partial<RouteInput['signals']> = {}) =>
  signals({ stickyTurns: 2, escalationStep: step, ...extra });
