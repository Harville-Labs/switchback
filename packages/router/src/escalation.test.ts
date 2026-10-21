import { describe, expect, test } from 'bun:test';
import { RoutingConfig } from './config.ts';
import { SignalTracker } from './signals.ts';
import { input, LADDER, model, on, routed, router, signals, stuck } from './test-support.ts';

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
    // From the current model to the first step.
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

  test("the model's request climbs one step and follows the escalation policy", () => {
    const asked = signals({ modelRequest: 'needs a deeper refactor' });
    const d = routed(router().decide(input({ signals: asked })));
    expect(d).toMatchObject({ rule: 'model-escalation', model: { alias: 'large' }, step: 1 });
    expect(d.reason).toContain('needs a deeper refactor');
    // A remote step asks first under `ask`, and nothing happens under `off`.
    const ask = { ...LADDER, escalation: { policy: 'ask' } };
    const fromOne = signals({ modelRequest: 'stuck', stickyTurns: 2, escalationStep: 1 });
    expect(router(ask).decide(input({ signals: fromOne }))).toMatchObject({
      kind: 'ask',
      rule: 'model-escalation',
      target: { alias: 'opus' },
    });
    const off = { ...LADDER, escalation: { policy: 'off' } };
    expect(routed(router(off).decide(input({ signals: asked }))).rule).toBe('default');
    // The user's own request comes first.
    expect(routed(router().decide(input({ escalateNow: true, signals: asked }))).rule).toBe(
      'user-escalation',
    );
  });

  test('the model asks once: the next call spends the request', () => {
    const t = new SignalTracker(RoutingConfig.parse({}).escalation);
    t.recordEscalationRequest('stuck');
    expect(t.snapshot().modelRequest).toBe('stuck');
    t.recordTurn(0, false);
    expect(t.snapshot().modelRequest).toBeUndefined();
  });

  test('escalating now from a private session stays local', () => {
    const d = router().decide(
      input({ escalateNow: true, signals: on(1), privacy: { reason: 'read .env' } }),
    );
    expect(d).toMatchObject({ rule: 'privacy' });
  });
});
