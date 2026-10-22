import { describe, expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { type Provider, ProviderError, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { engineFixture } from './engine-fixture.ts';

const { ws, setup } = engineFixture();

describe('what clients show', () => {
  test('an edit reports its diff to clients, never to the model', async () => {
    const { engine, lp, events } = setup(
      [
        {
          toolCalls: [
            { name: 'edit', input: { path: 'hello.txt', oldString: 'world', newString: 'there' } },
          ],
        },
        { text: 'done' },
      ],
      [],
    );
    await engine.runTurn(engine.createSession({}).id, 'edit it');
    const done = events.find((e) => e.type === 'tool.completed');
    expect(done).toMatchObject({ name: 'edit', isError: false });
    expect(done?.type === 'tool.completed' && done.diff).toContain('-hello world\n+hello there');
    const sent = JSON.stringify(lp.requests[1]?.messages.at(-1));
    expect(sent).not.toContain('+hello there');
  });

  test("routing says how big the chosen model's context is", async () => {
    const { engine, events } = setup([{ text: 'hi' }], []);
    await engine.runTurn(engine.createSession({}).id, 'hello');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({ contextWindow: 8_000 });
  });
});

describe('escalation cost and routing analytics', () => {
  test('an escalation prompt carries a cost estimate and the ledger records the rule', async () => {
    const { engine, events } = setup(
      [{ error: new ProviderError('bad output', 'lp', false) }],
      [{ text: 'remote answer' }],
      { config: { routing: { escalation: { policy: 'ask' } } } },
    );
    engine.subscribe((e) => {
      if (e.type === 'escalation.requested') engine.respondEscalation(e.requestId, true);
    });
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'x'.repeat(4_000));
    expect(r.text).toBe('remote answer');
    const ask = events.find((e) => e.type === 'escalation.requested');
    // claude-opus-5 is $5/M input: ~1k+ prompt tokens, so a few tenths of a cent at least.
    expect(ask?.type === 'escalation.requested' && ask.estimatedCostUsd).toBeGreaterThan(0.005);
    const report = engine.usage('today');
    expect(report.byRule?.map((row) => row.key)).toEqual(['escalation']);
    expect(report.byAgent?.[0]).toMatchObject({ key: 'build', calls: 1 });
    expect(report.byModel?.[0]?.key).toBe('rp/claude-opus-5');
  });

  test('no estimate when the target model has no known price', async () => {
    const { engine, events } = setup(
      [{ error: new ProviderError('bad output', 'lp', false) }, { text: 'local' }],
      [],
      {
        config: {
          models: {
            local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
            remote: { provider: 'rp', model: 'unpriced-model', contextWindow: 100_000 },
          },
          routing: { escalation: { policy: 'ask' } },
        },
      },
    );
    engine.subscribe((e) => {
      if (e.type === 'escalation.requested') engine.respondEscalation(e.requestId, false);
    });
    await engine.runTurn(engine.createSession({}).id, 'hi');
    const ask = events.find((e) => e.type === 'escalation.requested');
    expect(ask).toBeDefined();
    expect(ask && 'estimatedCostUsd' in ask).toBe(false);
  });
});

describe('several providers at once', () => {
  test('two local servers and two remote providers: a down local server falls to the other', async () => {
    const laptop = Object.assign(new ScriptedProvider('laptop', 'local', [{ text: 'laptop' }]), {
      health: async () => ({ ok: false, detail: 'connection refused' }),
    });
    const gpu = new ScriptedProvider('gpu', 'local', [{ text: 'from the gpu box' }]);
    const openai = new ScriptedProvider('openai', 'remote', []);
    const deepseek = new ScriptedProvider('deepseek', 'remote', []);
    const engine = new Engine({
      workspaceRoot: ws.root,
      config: SwitchbackConfig.parse({
        providers: {
          laptop: { type: 'mock', tier: 'local' },
          gpu: { type: 'mock', tier: 'local' },
          openai: { type: 'mock', tier: 'remote' },
          deepseek: { type: 'mock', tier: 'remote' },
        },
        models: {
          small: { provider: 'laptop', model: 'qwen3:8b', contextWindow: 32_000 },
          big: { provider: 'gpu', model: 'qwen3-coder-30b', contextWindow: 128_000 },
          sol: { provider: 'openai', model: 'gpt-6-sol' },
          pro: { provider: 'deepseek', model: 'deepseek-v4-pro' },
        },
        routing: { current: ['small', 'big'], escalate: [['sol', 'pro']] },
      }),
      providers: new Map<string, Provider>([
        ['laptop', laptop],
        ['gpu', gpu],
        ['openai', openai],
        ['deepseek', deepseek],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const r = await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(r.text).toBe('from the gpu box');
    expect(events.find((e) => e.type === 'route.decided')).toMatchObject({
      tier: 'local',
      rule: 'fallback',
      model: { provider: 'gpu' },
    });
    expect(engine.initialize().models.map((m) => m.alias)).toEqual(['small', 'big', 'sol', 'pro']);
  });
});

describe('refusal fallback', () => {
  test('a remote refusal retries on the next remote provider; the refusal is not kept', async () => {
    const anthropic = new ScriptedProvider('anthropic', 'remote', [
      { text: 'I can’t help with that', stopReason: 'refusal' },
    ]);
    const openai = new ScriptedProvider('openai', 'remote', [{ text: 'here you go' }]);
    const engine = new Engine({
      workspaceRoot: ws.root,
      config: SwitchbackConfig.parse({
        providers: {
          anthropic: { type: 'mock', tier: 'remote' },
          openai: { type: 'mock', tier: 'remote' },
        },
        models: {
          opus: { provider: 'anthropic', model: 'claude-opus-5' },
          sol: { provider: 'openai', model: 'gpt-6-sol' },
        },
        routing: { current: ['opus', 'sol'] },
      }),
      providers: new Map<string, Provider>([
        ['anthropic', anthropic],
        ['openai', openai],
      ]),
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    const s = engine.createSession({});
    const r = await engine.runTurn(s.id, 'hi');
    expect(r).toEqual({ stopReason: 'end_turn', text: 'here you go' });
    const routes = events.filter((e) => e.type === 'route.decided');
    expect(routes.map((e) => (e as { rule: string }).rule)).toEqual([
      'default',
      'refusal-fallback',
    ]);
    expect(engine.getSession(s.id).messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Both calls are billed.
    expect(
      engine
        .usage('today')
        .byRule?.map((row) => row.key)
        .sort(),
    ).toEqual(['default', 'refusal-fallback']);
  });

  test('with no other remote model the refusal ends the turn as a refusal', async () => {
    const { engine } = setup([], [{ text: 'no', stopReason: 'refusal' }], {
      config: { routing: { current: ['remote'], escalate: [] } },
    });
    const r = await engine.runTurn(engine.createSession({}).id, 'hi');
    expect(r.stopReason).toBe('refusal');
  });
});

describe('prompt caching', () => {
  test('consecutive requests share a byte-identical prefix', async () => {
    const { engine, rp } = setup(
      [],
      [
        { toolCalls: [{ name: 'read', input: { path: 'hello.txt' } }] },
        { text: 'it says hello' },
        { text: 'second answer' },
      ],
      { config: { routing: { current: ['remote'], escalate: [] } } },
    );
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'read hello.txt');
    await engine.runTurn(s.id, 'and again');
    expect(rp.requests).toHaveLength(3);
    const [first, ...rest] = rp.requests.map((r) => ({
      system: r.system,
      tools: JSON.stringify(r.tools),
      messages: JSON.stringify(r.messages),
      count: r.messages.length,
      raw: r.messages,
    }));
    for (const next of rest) {
      expect(next.system).toBe(first?.system ?? '');
      expect(next.tools).toBe(first?.tools ?? '');
    }
    // Each request's transcript starts with the previous request's, byte for byte.
    const all = [first, ...rest];
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      if (!prev || !cur) throw new Error('missing request');
      expect(JSON.stringify(cur.raw.slice(0, prev.count))).toBe(prev.messages);
    }
  });

  test('warns once when a follow-up call to the same remote model misses the cache', async () => {
    const miss = { inputTokens: 20_000, outputTokens: 50, cacheReadTokens: 0 };
    const hit = { inputTokens: 500, outputTokens: 50, cacheReadTokens: 19_500 };
    const warnings = async (usages: (typeof miss)[]) => {
      const { engine, events } = setup(
        [],
        usages.map((usage, i) =>
          i < usages.length - 1
            ? { toolCalls: [{ name: 'read', input: { path: 'hello.txt', n: i } }], usage }
            : { text: 'done', usage },
        ),
        { config: { routing: { current: ['remote'], escalate: [] } } },
      );
      await engine.runTurn(engine.createSession({}).id, 'go');
      return events.filter(
        (e) => e.type === 'log' && e.level === 'warn' && /prompt-cache/.test(e.message),
      );
    };
    expect(await warnings([miss, hit, hit])).toHaveLength(0);
    expect(await warnings([miss, miss, miss])).toHaveLength(1);
    // Small prompts can legitimately miss (below the provider's cacheable minimum).
    expect(
      await warnings([
        { ...miss, inputTokens: 900 },
        { ...miss, inputTokens: 900 },
      ]),
    ).toHaveLength(0);
  });
});
