import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EngineEvent, type Message, textOf } from '@harness/protocol';
import { type Provider, ScriptedProvider } from '@harness/providers';
import {
  chooseBoundary,
  contextOf,
  latestMarker,
  markerOf,
  renderForSummary,
  SUMMARIZER_PROMPT,
} from './compaction.ts';
import { HarnessConfig } from './config.ts';
import { Engine } from './engine.ts';
import { FileSessionStore } from './store.ts';
import { messageTokens, promptTokens } from './tokens.ts';

const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', text }] });
const assistant = (text: string): Message => ({
  role: 'assistant',
  parts: [{ type: 'text', text }],
});
const call = (id: string): Message => ({
  role: 'assistant',
  parts: [{ type: 'tool_call', id, name: 'read', input: { path: 'a.ts' } }],
});
const result = (id: string, content = 'x'.repeat(400)): Message => ({
  role: 'user',
  parts: [{ type: 'tool_result', callId: id, content }],
});

describe('contextOf', () => {
  test('without a marker it is the transcript', () => {
    const ms = [user('hi'), assistant('hello')];
    expect(contextOf(ms)).toEqual(ms);
  });

  test('with markers: latest summary, then verbatim from keepFrom, markers excluded', () => {
    const ms: Message[] = [
      user('one'),
      assistant('a1'),
      user('two'),
      assistant('a2'),
      {
        role: 'user',
        parts: [
          { type: 'compaction', summary: 'S1', keepFrom: 3, tokensBefore: 9, tokensAfter: 3 },
        ],
      },
      user('three'),
      assistant('a3'),
      {
        role: 'user',
        parts: [
          { type: 'compaction', summary: 'S2', keepFrom: 6, tokensBefore: 9, tokensAfter: 3 },
        ],
      },
      user('four'),
    ];
    const ctx = contextOf(ms);
    expect(ctx[0]?.parts[0]).toMatchObject({ type: 'text' });
    expect(textOf(ctx[0] as Message)).toContain('S2');
    expect(ctx.slice(1)).toEqual([assistant('a3'), user('four')]);
    expect(ctx.some((m) => markerOf(m))).toBe(false);
    // Same marker, same summary object: token counts stay cached.
    expect(contextOf(ms)[0]).toBe(ctx[0] as Message);
    expect(latestMarker(ms)?.index).toBe(7);
  });
});

describe('chooseBoundary', () => {
  const convo = [
    user('task'),
    call('c1'),
    result('c1'),
    call('c2'),
    result('c2'),
    call('c3'),
    result('c3'),
    assistant('done'),
  ];

  test('keeps recent messages verbatim and starts at an assistant message', () => {
    // Budget for roughly the last three messages.
    const lastThree = convo.slice(-3).reduce((n, m) => n + messageTokens(m), 0);
    const b = chooseBoundary(convo, 0, lastThree) ?? -1;
    expect(convo[b]?.role).toBe('assistant');
    expect(b).toBeGreaterThanOrEqual(2);
    // Never splits a tool call from its result.
    const kept = convo.slice(b);
    for (const m of kept)
      for (const p of m.parts)
        if (p.type === 'tool_result')
          expect(
            kept.some((k) => k.parts.some((q) => q.type === 'tool_call' && q.id === p.callId)),
          ).toBe(true);
  });

  test('nothing worth compacting', () => {
    expect(chooseBoundary([user('hi'), assistant('hello')], 0, 10_000)).toBeUndefined();
  });

  test('even when the last exchange is over budget, the final assistant message is kept', () => {
    expect(chooseBoundary(convo, 0, 1)).toBe(7);
  });
});

test('summarizer input trims long tool output and skips reasoning', () => {
  const blocks = renderForSummary([
    user('fix it'),
    {
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'secret', origin: { provider: 'p', model: 'm' } }],
    },
    result('c', 'y'.repeat(5_000)),
  ]);
  expect(blocks[0]).toBe('[user] fix it');
  expect(blocks.join('')).not.toContain('secret');
  expect(blocks[1]).toContain('more characters');
});

describe('engine compaction', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-compact-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function engine(localWindow: number, extra: object = {}) {
    const summaries: string[] = [];
    const health = { up: true };
    const clock = { t: Date.parse('2026-09-27T12:00:00Z') };
    const local = new ScriptedProvider('lp', 'local', (req) => {
      if (req.system === SUMMARIZER_PROMPT) {
        const text = textOf(req.messages[0] as Message);
        summaries.push(text);
        return { text: `summary #${summaries.length}: user asked for steps; progress noted` };
      }
      return { text: `ok ${'z'.repeat(600)}` };
    });
    local.health = async () => ({ ok: health.up, detail: health.up ? 'up' : 'down' });
    const remote = new ScriptedProvider('rp', 'remote', () => ({ text: 'remote' }));
    const store = new FileSessionStore(join(root, 'sessions'));
    const e = new Engine({
      workspaceRoot: root,
      config: HarnessConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
        models: {
          local: { provider: 'lp', model: 'small', contextWindow: localWindow },
          remote: { provider: 'rp', model: 'big', contextWindow: 1_000_000 },
        },
        permissions: { bash: 'deny' },
        ...extra,
      }),
      providers: new Map<string, Provider>([
        ['lp', local],
        ['rp', remote],
      ]),
      store,
      now: () => new Date(clock.t),
    });
    const events: EngineEvent[] = [];
    e.subscribe((ev) => events.push(ev));
    return { e, local, remote, summaries, events, store, health, clock };
  }

  test('a 200-turn session stays local and under the window; the transcript keeps everything', async () => {
    const { e, local, remote, events, store } = engine(16_000);
    const s = e.createSession({});
    for (let i = 0; i < 200; i++) await e.runTurn(s.id, `step ${i}: ${'w'.repeat(300)}`);

    expect(remote.requests).toHaveLength(0);
    const system = local.requests.find((r) => r.system !== SUMMARIZER_PROMPT)?.system ?? '';
    const tools = JSON.stringify(local.requests.find((r) => r.system !== SUMMARIZER_PROMPT)?.tools);
    for (const r of local.requests) {
      if (r.system === SUMMARIZER_PROMPT) continue;
      expect(promptTokens(system, r.messages, tools)).toBeLessThan(16_000 * 0.85);
    }
    const compactions = events.filter((ev) => ev.type === 'context.compacted');
    expect(compactions.length).toBeGreaterThan(1);

    // Every original message is still in memory and on disk.
    const messages = e.getSession(s.id).messages;
    expect(messages.filter((m) => m.role === 'user' && !markerOf(m))).toHaveLength(200);
    expect(store.load(s.id)?.messages.length).toBe(messages.length);
    // The latest request starts with the latest summary, which folds in earlier ones.
    const last = local.requests.findLast((r) => r.system !== SUMMARIZER_PROMPT);
    expect(textOf(last?.messages[0] as Message)).toContain(`summary #${compactions.length}`);
  }, 30_000);

  test('session.compact compacts on demand; the view shows it', async () => {
    const { e, events } = engine(1_000_000);
    const s = e.createSession({});
    for (let i = 0; i < 6; i++) await e.runTurn(s.id, `step ${i}`);
    expect(events.some((ev) => ev.type === 'context.compacted')).toBe(false);
    expect(await e.compactSession(s.id)).toEqual({ compacted: true });
    expect(events.find((ev) => ev.type === 'context.compacted')).toMatchObject({
      type: 'context.compacted',
    });
  });

  test('without a reachable local model, local-only routing never pays for a summary', async () => {
    const { e, remote, health, clock, events } = engine(16_000, {
      routing: { mode: 'local-only' },
    });
    const s = e.createSession({});
    for (let i = 0; i < 12; i++) await e.runTurn(s.id, `step ${i}: ${'w'.repeat(300)}`);
    health.up = false;
    clock.t += 60_000; // past the health cache
    expect(await e.compactSession(s.id)).toEqual({ compacted: false });
    expect(events.some((ev) => ev.type === 'log' && /no model is available/.test(ev.message))).toBe(
      true,
    );
    expect(remote.requests).toHaveLength(0);
    expect(events.some((ev) => ev.type === 'route.decided' && ev.tier === 'remote')).toBe(false);
  });

  test('disabled: no automatic compaction', async () => {
    const { e, events } = engine(16_000, { compaction: { enabled: false } });
    const s = e.createSession({});
    for (let i = 0; i < 30; i++) await e.runTurn(s.id, `step ${i}: ${'w'.repeat(300)}`);
    expect(events.some((ev) => ev.type === 'context.compacted')).toBe(false);
  });
});
