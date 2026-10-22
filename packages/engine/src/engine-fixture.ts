import { afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine, type EngineOptions } from './engine.ts';

/**
 * A fresh workspace per test (with a hello.txt), and an engine on two scripted
 * providers: `lp` (local) and `rp` (remote). Call at the top of a test file.
 */
export function engineFixture() {
  const ws = { root: '' };
  beforeEach(() => {
    ws.root = mkdtempSync(join(tmpdir(), 'switchback-test-'));
    writeFileSync(join(ws.root, 'hello.txt'), 'hello world\n');
  });
  afterEach(() => rmSync(ws.root, { recursive: true, force: true }));

  function setup(
    local: Script,
    remote: Script,
    {
      config: overrides,
      ...opts
    }: Partial<Omit<EngineOptions, 'config'>> & { config?: object } = {},
  ) {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
      models: {
        local: { provider: 'lp', model: 'small', contextWindow: 8_000 },
        remote: { provider: 'rp', model: 'claude-opus-5', contextWindow: 1_000_000 },
      },
      permissions: { edit: 'allow', bash: 'deny' },
      ...overrides,
      routing: {
        current: ['local'],
        escalate: [['remote']],
        ...(overrides as { routing?: object } | undefined)?.routing,
      },
    });
    const lp = new ScriptedProvider('lp', 'local', local);
    const rp = new ScriptedProvider('rp', 'remote', remote);
    const engine = new Engine({
      workspaceRoot: ws.root,
      config,
      providers: new Map([
        ['lp', lp],
        ['rp', rp],
      ]),
      ...opts,
    });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    return { engine, lp, rp, events };
  }

  return { ws, setup };
}
