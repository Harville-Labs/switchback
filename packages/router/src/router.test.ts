import { describe, expect, test } from 'bun:test';
import { RoutingConfig } from './config.ts';
import { type ModelInfo, type RouteInput, Router } from './router.ts';
import { SignalTracker } from './signals.ts';

const model = (
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
const MODELS: Record<string, ModelInfo> = {
  fast: model('fast', 'local', 32_000),
  large: model('large', 'local', 128_000),
  opus: model('opus', 'remote', 1_000_000),
  sonnet: model('sonnet', 'remote', 400_000),
  haiku: model('haiku', 'remote', 200_000),
};

const LADDER = { start: ['fast'], escalate: ['large', 'opus'] };

function router(
  config: Record<string, unknown> = LADDER,
  overrides: Record<string, ModelInfo> = {},
) {
  const models = { ...MODELS, ...overrides };
  return new Router(RoutingConfig.parse(config), (alias) => models[alias]);
}

const signals = (extra: Partial<RouteInput['signals']> = {}) => ({
  ...new SignalTracker(RoutingConfig.parse({}).escalation).snapshot(),
  ...extra,
});

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    preference: 'auto',
    agent: { name: 'build', route: 'auto' },
    estimatedInputTokens: 1_000,
    signals: signals(),
    spend: { todayUsd: 0, monthUsd: 0 },
    ...overrides,
  };
}

function routed(d: ReturnType<Router['decide']>) {
  if (d.kind !== 'route') throw new Error(`expected route, got ${d.kind}: ${d.reason}`);
  return d;
}

const stuck = signals({ consecutiveToolErrors: 3 });
const on = (step: number, extra: Partial<RouteInput['signals']> = {}) =>
  signals({ stickyTurns: 2, escalationStep: step, ...extra });

describe('roles', () => {
  test('turns begin on the start model', () => {
    const d = routed(router().decide(input()));
    expect(d).toMatchObject({ rule: 'default', model: { alias: 'fast' }, step: 0 });
  });

  test('all remote: start and escalate across remote models', () => {
    const r = router({ start: ['haiku'], escalate: ['opus'] });
    expect(routed(r.decide(input())).model.alias).toBe('haiku');
    const up = routed(r.decide(input({ signals: stuck })));
    expect(up).toMatchObject({ rule: 'escalation', model: { alias: 'opus' }, step: 1 });
  });

  test('all local: nothing remote is ever chosen', () => {
    const r = router({ start: ['fast'], escalate: ['large'] });
    expect(routed(r.decide(input({ signals: stuck }))).model.alias).toBe('large');
    expect(
      routed(r.decide(input({ signals: on(1, { consecutiveToolErrors: 3 }) }))).model.alias,
    ).toBe('large');
  });

  test('a step can be a chain of alternatives', () => {
    const r = router(
      { start: ['fast'], escalate: [['sonnet', 'opus']] },
      { sonnet: model('sonnet', 'remote', 400_000, false) },
    );
    const d = routed(r.decide(input({ signals: stuck })));
    expect(d).toMatchObject({ model: { alias: 'opus' }, step: 1, rule: 'fallback' });
    expect(d.reason).toContain('sonnet is unavailable; using opus');
  });

  test('with no start model, turns begin on the first step; with no models, blocked', () => {
    const d = routed(router({ escalate: ['opus'] }).decide(input()));
    expect(d).toMatchObject({ model: { alias: 'opus' }, step: 1 });
    expect(router({}).decide(input())).toMatchObject({ kind: 'block', rule: 'default' });
  });
});

describe('escalation ladder', () => {
  test('one step at a time, with the reason', () => {
    const d = routed(router().decide(input({ signals: stuck })));
    expect(d).toMatchObject({
      rule: 'escalation',
      model: { alias: 'large' },
      step: 1,
      escalated: true,
    });
    expect(d.reason).toBe('3 consecutive tool errors; escalating to large (step 1 of 2)');
  });

  test('stays on the step it reached, then climbs if that model struggles too', () => {
    const sticky = routed(router().decide(input({ signals: on(1) })));
    expect(sticky).toMatchObject({ rule: 'sticky', model: { alias: 'large' }, step: 1 });
    expect(sticky.reason).toBe('recently escalated to large (2 turns left)');
    const up = routed(router().decide(input({ signals: on(1, { consecutiveToolErrors: 3 }) })));
    expect(up).toMatchObject({ rule: 'escalation', model: { alias: 'opus' }, step: 2 });
  });

  test('every quality signal escalates', () => {
    for (const s of [
      { turnFailed: true },
      { loopDetected: true },
      { malformedToolCalls: 2 },
      { consecutiveToolErrors: 3 },
    ])
      expect(routed(router().decide(input({ signals: signals(s) }))).rule).toBe('escalation');
  });

  test('ask: local steps never ask; a remote step does, then honors approval', () => {
    const r = router({ ...LADDER, escalation: { policy: 'ask' } });
    expect(routed(r.decide(input({ signals: stuck }))).model.alias).toBe('large');
    const ask = r.decide(input({ signals: on(1, { consecutiveToolErrors: 3 }) }));
    expect(ask).toMatchObject({ kind: 'ask', target: { alias: 'opus' } });
    const ok = r.decide(
      input({ signals: on(1, { consecutiveToolErrors: 3 }), escalationApproved: true }),
    );
    expect(routed(ok).model.alias).toBe('opus');
  });

  test('a declined escalation stays where it is and says so', () => {
    const d = routed(router().decide(input({ signals: on(1), escalationDeclined: true })));
    expect(d).toMatchObject({ rule: 'escalation-declined', model: { alias: 'large' } });
    expect(d.reason).toBe('escalation was declined; staying on large');
  });

  test('off: no escalation on quality signals at any step', () => {
    const d = routed(
      router({ ...LADDER, escalation: { policy: 'off' } }).decide(input({ signals: stuck })),
    );
    expect(d.model.alias).toBe('fast');
  });

  test('a step that is down or too small is skipped', () => {
    const down = routed(
      router(LADDER, { large: model('large', 'local', 128_000, false) }).decide(
        input({ signals: stuck }),
      ),
    );
    expect(down).toMatchObject({ model: { alias: 'opus' }, step: 2 });
    const small = routed(router().decide(input({ signals: stuck, estimatedInputTokens: 150_000 })));
    expect(small.model.alias).toBe('opus');
  });

  test('escalating now climbs one step from where the session is, without asking', () => {
    const ask = { ...LADDER, escalation: { policy: 'ask' } };
    // From the start model to the first step.
    expect(routed(router(ask).decide(input({ escalateNow: true })))).toMatchObject({
      rule: 'user-escalation',
      model: { alias: 'large' },
      step: 1,
      escalated: true,
    });
    // From step 1 to the remote step: the user asked, so no approval prompt.
    expect(routed(router(ask).decide(input({ escalateNow: true, signals: on(1) })))).toMatchObject({
      rule: 'user-escalation',
      model: { alias: 'opus' },
      step: 2,
    });
    // Budgets still apply.
    const spent = router({ ...LADDER, budget: { dailyUsd: 1 } }).decide(
      input({ escalateNow: true, signals: on(1), spend: { todayUsd: 2, monthUsd: 2 } }),
    );
    expect(spent).not.toMatchObject({ model: { alias: 'opus' } });
  });

  test('escalating now from a private session stays local', () => {
    const d = router().decide(
      input({ escalateNow: true, signals: on(1), privacy: { reason: 'read .env' } }),
    );
    expect(d).toMatchObject({ rule: 'privacy' });
  });
});

describe('context overflow', () => {
  test('goes to the first step whose window fits', () => {
    const d = routed(router().decide(input({ estimatedInputTokens: 60_000 })));
    expect(d).toMatchObject({ rule: 'context-overflow', model: { alias: 'large' }, step: 1 });
    const big = routed(router().decide(input({ estimatedInputTokens: 200_000 })));
    expect(big).toMatchObject({ rule: 'context-overflow', model: { alias: 'opus' }, step: 2 });
  });

  test('when nothing fits, the largest window above is still the best chance', () => {
    const d = routed(router().decide(input({ estimatedInputTokens: 5_000_000 })));
    expect(d).toMatchObject({ rule: 'context-overflow', model: { alias: 'opus' } });
  });

  test('a start chain prefers a member that fits before escalating', () => {
    const r = router({ start: ['fast', 'large'], escalate: ['opus'] });
    const d = routed(r.decide(input({ estimatedInputTokens: 60_000 })));
    expect(d).toMatchObject({ rule: 'context-fit', model: { alias: 'large' }, step: 0 });
  });

  test('with images, a chain prefers a member that can see them', () => {
    const seeing = { large: { ...MODELS.large, vision: true } as ModelInfo };
    const r = router({ start: ['fast', 'large'], escalate: ['opus'] }, seeing);
    expect(routed(r.decide(input({ images: true })))).toMatchObject({
      rule: 'vision',
      model: { alias: 'large' },
      step: 0,
    });
    // No images: the first member, as always.
    expect(routed(r.decide(input())).model.alias).toBe('fast');
    // Fitting the prompt still comes first: a seeing model that can't hold it isn't chosen.
    expect(
      routed(r.decide(input({ images: true, estimatedInputTokens: 200_000 }))).model.alias,
    ).not.toBe('fast');
  });

  test('with images and no member that can see them, the chain is unchanged', () => {
    const r = router({ start: ['fast', 'large'], escalate: ['opus'] });
    expect(routed(r.decide(input({ images: true }))).model.alias).toBe('fast');
  });
});

describe('tier filters and pins', () => {
  test('/local and /remote pick the first model of that tier in role order', () => {
    expect(routed(router().decide(input({ preference: 'remote' })))).toMatchObject({
      rule: 'user-override',
      model: { alias: 'opus' },
      step: 2,
    });
    const r = router({ start: ['haiku'], escalate: ['large', 'opus'] });
    expect(routed(r.decide(input({ preference: 'local' }))).model.alias).toBe('large');
  });

  test('a tier with no model in any role is refused with a pointer to init', () => {
    const d = router({ start: ['opus'] }).decide(input({ preference: 'local' }));
    expect(d).toMatchObject({ kind: 'block', rule: 'user-override' });
    expect((d as { reason: string }).reason).toContain('no local model is in routing.start');
  });

  test('a user override beats an agent pin', () => {
    const d = routed(
      router().decide(input({ preference: 'remote', agent: { name: 'x', route: 'local' } })),
    );
    expect(d.model.alias).toBe('opus');
  });

  test('an agent can pin any alias, or a tier', () => {
    const alias = routed(
      router().decide(input({ agent: { name: 'r', route: 'auto', model: 'haiku' } })),
    );
    expect(alias).toMatchObject({ rule: 'agent-pin', model: { alias: 'haiku' } });
    const tier = routed(router().decide(input({ agent: { name: 'explore', route: 'local' } })));
    expect(tier).toMatchObject({ rule: 'agent-pin', model: { alias: 'fast' } });
    // A tier pin with no model of that tier routes normally.
    const none = routed(
      router({ start: ['opus'] }).decide(input({ agent: { name: 'explore', route: 'local' } })),
    );
    expect(none).toMatchObject({ rule: 'default', model: { alias: 'opus' } });
  });
});

describe('remote off (allowRemote: false)', () => {
  const r = router({ ...LADDER, allowRemote: false });

  test('escalations skip remote steps', () => {
    expect(routed(r.decide(input({ signals: stuck }))).model.alias).toBe('large');
    const top = routed(r.decide(input({ signals: on(1, { consecutiveToolErrors: 3 }) })));
    expect(top).toMatchObject({ rule: 'sticky', model: { alias: 'large' } });
  });

  test('an explicit remote request is refused; a remote pin runs locally', () => {
    expect(r.decide(input({ preference: 'remote' }))).toMatchObject({
      kind: 'block',
      rule: 'remote-off',
    });
    const pinned = routed(r.decide(input({ agent: { name: 'a', route: 'auto', model: 'opus' } })));
    expect(pinned).toMatchObject({ rule: 'remote-off', model: { tier: 'local' } });
  });
});

describe('budgets', () => {
  const spent = { todayUsd: 10, monthUsd: 10 };

  test('a spent budget keeps a remote step local; local steps are never limited', () => {
    const r = router({ ...LADDER, budget: { dailyUsd: 5 } });
    const top = routed(
      r.decide(input({ signals: on(1, { consecutiveToolErrors: 3 }), spend: spent })),
    );
    expect(top).toMatchObject({ rule: 'budget', model: { alias: 'large' } });
    expect(routed(r.decide(input({ signals: stuck, spend: spent }))).model.alias).toBe('large');
  });

  test('block mode blocks instead', () => {
    const r = router({ ...LADDER, budget: { dailyUsd: 5, onExceeded: 'block' } });
    expect(r.decide(input({ signals: on(2), spend: spent }))).toMatchObject({
      kind: 'block',
      rule: 'budget',
    });
  });

  test('an explicit remote request ignores the budget', () => {
    const r = router({ ...LADDER, budget: { dailyUsd: 5 } });
    expect(routed(r.decide(input({ preference: 'remote', spend: spent }))).model.alias).toBe(
      'opus',
    );
  });
});

describe('outages', () => {
  test('the start model down: the nearest step up', () => {
    const r = router(LADDER, { fast: model('fast', 'local', 32_000, false) });
    const d = routed(r.decide(input()));
    expect(d).toMatchObject({ rule: 'fallback', model: { alias: 'large' }, step: 1 });
  });

  test('the top step down: back down the ladder', () => {
    const r = router(LADDER, { opus: model('opus', 'remote', 1_000_000, false) });
    const d = routed(r.decide(input({ preference: 'remote' })));
    expect(d).toMatchObject({ rule: 'fallback', model: { alias: 'large' } });
  });

  test('fallback: none stops instead', () => {
    const r = router(
      { ...LADDER, fallback: 'none' },
      { fast: model('fast', 'local', 32_000, false) },
    );
    expect(r.decide(input())).toMatchObject({ kind: 'block', rule: 'fallback' });
  });

  test('everything down: blocked', () => {
    const down = Object.fromEntries(
      Object.values(MODELS).map((m) => [m.alias, { ...m, available: false }]),
    );
    expect(router(LADDER, down).decide(input())).toMatchObject({ kind: 'block', rule: 'fallback' });
  });

  test('remote off: an outage never falls back to a remote model', () => {
    const r = router(
      { start: ['fast'], escalate: ['opus'], allowRemote: false },
      { fast: model('fast', 'local', 32_000, false) },
    );
    expect(r.decide(input())).toMatchObject({ kind: 'block', rule: 'fallback' });
  });
});

describe('privacy', () => {
  const privacy = { reason: 'secrets/prod.env' };

  test('a private session stays local, even on an explicit remote request', () => {
    const d = routed(router().decide(input({ preference: 'remote', privacy })));
    expect(d).toMatchObject({ rule: 'privacy', model: { tier: 'local' } });
    expect(d.reason).toContain('secrets/prod.env');
  });

  test('it can still climb through local steps, and stops there', () => {
    expect(routed(router().decide(input({ signals: stuck, privacy }))).model.alias).toBe('large');
    const top = routed(
      router().decide(input({ signals: on(1, { consecutiveToolErrors: 3 }), privacy })),
    );
    expect(top).toMatchObject({ rule: 'privacy', model: { tier: 'local' } });
  });

  test('never asks to escalate a private session', () => {
    const r = router({ start: ['fast'], escalate: ['opus'], escalation: { policy: 'ask' } });
    const d = routed(r.decide(input({ signals: stuck, privacy })));
    expect(d).toMatchObject({ rule: 'privacy', model: { alias: 'fast' } });
  });

  test('blocks rather than going remote when no local model is up', () => {
    const r = router(LADDER, {
      fast: model('fast', 'local', 32_000, false),
      large: model('large', 'local', 128_000, false),
    });
    expect(r.decide(input({ privacy }))).toMatchObject({ kind: 'block', rule: 'privacy' });
  });

  test('a session without private content routes normally', () => {
    expect(routed(router().decide(input({ preference: 'remote' }))).model.alias).toBe('opus');
  });
});

describe('refusals', () => {
  const r = router({ start: ['fast'], escalate: [['opus', 'sonnet'], 'haiku'] });

  test('retry on another model of the same step, and say who declined', () => {
    const d = routed(r.decide(input({ refused: ['opus'], refusalRetry: true })));
    expect(d).toMatchObject({ rule: 'refusal-fallback', model: { alias: 'sonnet' }, step: 1 });
    expect(d.reason).toBe('opus declined the request; retrying on sonnet');
  });

  test('with nobody left on that step, the next step up', () => {
    const d = routed(r.decide(input({ refused: ['opus', 'sonnet'], refusalRetry: true })));
    expect(d).toMatchObject({ model: { alias: 'haiku' }, step: 2 });
  });

  test('nobody left at all: blocked with the reason', () => {
    const d = r.decide(input({ refused: ['opus', 'sonnet', 'haiku'], refusalRetry: true }));
    expect(d).toMatchObject({ kind: 'block', rule: 'refusal-fallback' });
  });

  test('a model that refused is skipped for the rest of the turn', () => {
    const d = routed(r.decide(input({ refused: ['opus'], signals: on(1) })));
    expect(d).toMatchObject({ rule: 'sticky', model: { alias: 'sonnet' } });
  });
});

describe('agent budgets', () => {
  const budget = (spentUsd: number) => ({ agent: 'reviewer', limitUsd: 0.5, spentUsd });
  const onRemote = { signals: on(2) };

  test('under budget: no effect', () => {
    const d = routed(router().decide(input({ ...onRemote, invocationBudget: budget(0.2) })));
    expect(d).toMatchObject({ rule: 'sticky', model: { alias: 'opus' } });
  });

  test('spent: remote calls continue on the nearest local model', () => {
    const d = routed(router().decide(input({ ...onRemote, invocationBudget: budget(0.6) })));
    expect(d).toMatchObject({ rule: 'agent-budget', model: { alias: 'large' } });
    expect(d.reason).toContain('spent $0.60 of its $0.50 budget');
  });

  test('spent with no local model: the subagent is stopped', () => {
    const d = router({ start: ['haiku'], escalate: ['opus'] }).decide(
      input({ signals: on(1), invocationBudget: budget(0.6) }),
    );
    expect(d).toMatchObject({ kind: 'block', rule: 'agent-budget' });
  });

  test('local calls are never limited by a budget', () => {
    expect(routed(router().decide(input({ invocationBudget: budget(5) }))).model.alias).toBe(
      'fast',
    );
  });
});

describe('SignalTracker', () => {
  test('keeps the step for stickyTurns calls on it, then resets', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordTurn(1, true);
    expect(t.snapshot()).toMatchObject({ stickyTurns: 2, escalationStep: 1 });
    t.recordTurn(0, false); // a call elsewhere (a user override) doesn't count down
    t.recordTurn(1, false);
    t.recordTurn(1, false);
    expect(t.snapshot()).toMatchObject({ stickyTurns: 0, escalationStep: 0 });
  });

  test('detects tool-call loops regardless of key order', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordToolCall('read', { a: 1, b: 2 });
    t.recordToolCall('read', { b: 2, a: 1 });
    t.recordToolCall('read', { a: 1, b: 2 });
    expect(t.snapshot().loopDetected).toBe(true);
  });

  test('a failure counts until an escalation resets it; a new prompt keeps stickiness', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordFailure();
    expect(t.snapshot().turnFailed).toBe(true);
    t.recordTurn(1, true);
    expect(t.snapshot().turnFailed).toBe(false);
    t.startUserTurn();
    expect(t.snapshot().stickyTurns).toBe(2);
  });
});
