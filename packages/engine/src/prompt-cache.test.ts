import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-test-'));
  writeFileSync(join(root, 'hello.txt'), 'hello world\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Prefix stability itself is tested in engine.test.ts (`prompt caching`).
test('every call carries the session cache key and reports its own usage', async () => {
  const config = SwitchbackConfig.parse({
    providers: { rp: { type: 'mock', tier: 'remote' } },
    models: { remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 } },
    permissions: { read: 'allow' },
    routing: { current: ['remote'] },
  });
  const rp = new ScriptedProvider('rp', 'remote', [
    { toolCalls: [{ name: 'read', input: { path: 'hello.txt' } }] },
    { text: 'It says hello.', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 } },
    { text: 'Still hello.' },
  ]);
  const engine = new Engine({ workspaceRoot: root, config, providers: new Map([['rp', rp]]) });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  const s = engine.createSession({});
  await engine.runTurn(s.id, 'what does hello.txt say?');
  await engine.runTurn(s.id, 'and now?');

  expect(rp.requests).toHaveLength(3);
  expect(rp.requests.map((r) => r.cacheKey)).toEqual([s.id, s.id, s.id]);
  const stats = events.filter((e) => e.type === 'call.stats');
  expect(stats.map((e) => e.type === 'call.stats' && e.usage?.cacheReadTokens)).toEqual([
    undefined,
    90,
    undefined,
  ]);
});
