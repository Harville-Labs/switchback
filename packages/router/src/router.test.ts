import { describe, expect, test } from 'bun:test';
import { RoutingConfig } from './config.ts';
import { type ModelInfo, type RouteInput, Router } from './router.ts';
import { SignalTracker } from './signals.ts';

const LOCAL: ModelInfo = {
  alias: 'local',
  ref: { provider: 'ollama', model: 'qwen3-coder' },
  tier: 'local',
  contextWindow: 32_000,
  available: true,
};
const REMOTE: ModelInfo = {
  alias: 'remote',
  ref: { provider: 'anthropic', model: 'claude-opus-5' },
  tier: 'remote',
  contextWindow: 1_000_000,
  available: true,
};
const HAIKU: ModelInfo = {
  ...REMOTE,
  alias: 'haiku',
  ref: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

function router(config: unknown = {}, overrides: Partial<Record<string, ModelInfo>> = {}) {
  const models: Record<string, ModelInfo> = { local: LOCAL, remote: REMOTE, haiku: HAIKU };
  for (const [k, v] of Object.entries(overrides)) if (v) models[k] = v;
  return new Router(RoutingConfig.parse(config), (alias) => models[alias]);
}

function input(overrides: Partial<RouteInput> = {}): RouteInput {
  return {
    preference: 'auto',
    agent: { name: 'build', route: 'auto' },
    estimatedInputTokens: 1_000,
    signals: new SignalTracker(RoutingConfig.parse({}).escalation).snapshot(),
    spend: { todayUsd: 0, monthUsd: 0 },
    ...overrides,
  };
}

function routed(d: ReturnType<Router['decide']>) {
  if (d.kind !== 'route') throw new Error(`expected route, got ${d.kind}: ${d.reason}`);
  return d;
}

describe('Router', () => {
  test('routes local by default', () => {
    const d = routed(router().decide(input()));
    expect(d.model.alias).toBe('local');
    expect(d.rule).toBe('default');
  });

  test('user override beats agent pin and mode', () => {
    const r = router({ mode: 'local-only' });
    const d = routed(
      r.decide(input({ preference: 'remote', agent: { name: 'x', route: 'local' } })),
    );
    expect(d.model.alias).toBe('remote');
    expect(d.rule).toBe('user-override');
  });

  test('agent can pin a model alias (Claude Code style model: haiku)', () => {
    const d = routed(
      router().decide(input({ agent: { name: 'explore', route: 'auto', model: 'haiku' } })),
    );
    expect(d.model.alias).toBe('haiku');
    expect(d.rule).toBe('agent-pin');
  });

  test('escalates when the prompt will not fit the local context window', () => {
    const d = routed(router().decide(input({ estimatedInputTokens: 30_000 })));
    expect(d.model.alias).toBe('remote');
    expect(d.rule).toBe('context-overflow');
    expect(d.escalated).toBe(true);
  });

  test('escalates after consecutive tool errors', () => {
    const cfg = RoutingConfig.parse({});
    const t = new SignalTracker(cfg.escalation);
    for (let i = 0; i < 3; i++) t.recordToolResult(false);
    const d = routed(router().decide(input({ signals: t.snapshot() })));
    expect(d.rule).toBe('escalation');
    expect(d.reason).toContain('3 consecutive tool errors');
  });

  test('detects tool-call loops regardless of key order', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordToolCall('read', { path: 'a', limit: 1 });
    t.recordToolCall('read', { limit: 1, path: 'a' });
    t.recordToolCall('read', { path: 'a', limit: 1 });
    expect(t.snapshot().loopDetected).toBe(true);
  });

  test('ask policy asks instead of escalating, then honors approval', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordLocalFailure();
    const r = router({ escalation: { policy: 'ask' } });
    expect(r.decide(input({ signals: t.snapshot() })).kind).toBe('ask');
    const d = routed(r.decide(input({ signals: t.snapshot(), escalationApproved: true })));
    expect(d.model.alias).toBe('remote');
  });

  test('off policy never escalates on quality signals', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordLocalFailure();
    const d = routed(
      router({ escalation: { policy: 'off' } }).decide(input({ signals: t.snapshot() })),
    );
    expect(d.model.alias).toBe('local');
  });

  test('stays remote for stickyTurns after escalating, then returns local', () => {
    const cfg = RoutingConfig.parse({ escalation: { stickyTurns: 2 } });
    const t = new SignalTracker(cfg.escalation);
    t.recordTurn('remote', true);
    const r = router({ escalation: { stickyTurns: 2 } });
    expect(routed(r.decide(input({ signals: t.snapshot() }))).rule).toBe('sticky');
    t.recordTurn('remote', false);
    t.recordTurn('remote', false);
    expect(routed(r.decide(input({ signals: t.snapshot() }))).model.alias).toBe('local');
  });

  test('budget exhaustion keeps escalations local', () => {
    const d = routed(
      router({ budget: { dailyUsd: 1 } }).decide(
        input({ estimatedInputTokens: 30_000, spend: { todayUsd: 1.5, monthUsd: 1.5 } }),
      ),
    );
    expect(d.model.alias).toBe('local');
    expect(d.rule).toBe('budget');
  });

  test('budget block mode blocks instead', () => {
    const d = router({ budget: { monthlyUsd: 10, onExceeded: 'block' } }).decide(
      input({
        preference: 'auto',
        agent: { name: 'x', route: 'remote' },
        spend: { todayUsd: 0, monthUsd: 10 },
      }),
    );
    expect(d.kind).toBe('block');
  });

  test('explicit remote request ignores budget', () => {
    const d = routed(
      router({ budget: { dailyUsd: 1 } }).decide(
        input({ preference: 'remote', spend: { todayUsd: 5, monthUsd: 5 } }),
      ),
    );
    expect(d.model.alias).toBe('remote');
  });

  test('falls back to remote when local is down', () => {
    const d = routed(router({}, { local: { ...LOCAL, available: false } }).decide(input()));
    expect(d.model.alias).toBe('remote');
    expect(d.rule).toBe('fallback');
  });

  test('falls back to local when remote is down', () => {
    const d = routed(
      router({}, { remote: { ...REMOTE, available: false } }).decide(
        input({ preference: 'remote' }),
      ),
    );
    expect(d.model.alias).toBe('local');
  });

  test('blocks when everything is down', () => {
    const d = router(
      {},
      {
        local: { ...LOCAL, available: false },
        remote: { ...REMOTE, available: false },
      },
    ).decide(input());
    expect(d.kind).toBe('block');
  });

  describe('with no local model configured', () => {
    const remoteOnly = () =>
      new Router(RoutingConfig.parse({}), (alias) => (alias === 'remote' ? REMOTE : undefined));

    test('routes remote by default and says why', () => {
      const d = routed(remoteOnly().decide(input()));
      expect(d.model.alias).toBe('remote');
      expect(d.reason).toContain('harness init');
    });

    test('a local-pinned agent (explore) still runs instead of failing', () => {
      const d = routed(remoteOnly().decide(input({ agent: { name: 'explore', route: 'local' } })));
      expect(d.model.alias).toBe('remote');
    });

    test('an explicit local request is blocked with setup guidance', () => {
      const d = remoteOnly().decide(input({ preference: 'local' }));
      expect(d.kind).toBe('block');
      expect(d.kind === 'block' && d.reason).toContain('harness init');
    });
  });
});
