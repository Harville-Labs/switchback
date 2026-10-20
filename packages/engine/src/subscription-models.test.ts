import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import {
  type ListModels,
  readDiscovered,
  refreshSubscriptionModels,
  withSubscriptionModels,
} from './subscription-models.ts';

let env: Record<string, string>;
beforeEach(() => {
  env = { SWITCHBACK_HOME: mkdtempSync(join(tmpdir(), 'switchback-plan-models-')) };
});
afterEach(() => rmSync(env.SWITCHBACK_HOME as string, { recursive: true, force: true }));

const config = SwitchbackConfig.parse({
  providers: { codex: { type: 'codex' }, mine: { type: 'mock', tier: 'local' } },
  models: {
    main: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' },
    'gpt-6-luna': { provider: 'mine', model: 'something-else' },
  },
});

describe('withSubscriptionModels', () => {
  test('adds what the plan offers that config does not name, free on a subscription', () => {
    const merged = withSubscriptionModels(config, { codex: [{ id: 'gpt-7', label: 'GPT-7' }] });
    expect(merged.models['gpt-7']).toMatchObject({
      provider: 'codex',
      model: 'gpt-7',
      price: { input: 0, output: 0 },
    });
    // Already configured under another alias: left as the user wrote it.
    expect(merged.models['gpt-6-sol']).toBeUndefined();
    expect(merged.models.main?.effort).toBe('high');
  });

  test('the catalog stands in before the CLI has reported, and taken aliases are kept', () => {
    const merged = withSubscriptionModels(config);
    for (const m of CATALOG.openai.models.filter(
      (m) => m.id !== 'gpt-6-sol' && m.id !== 'gpt-6-luna',
    ))
      expect(merged.models[m.id]?.provider).toBe('codex');
    expect(merged.models['gpt-6-luna']?.provider).toBe('mine');
  });
});

describe('refreshSubscriptionModels', () => {
  test('caches what each CLI lists and says whether it changed', async () => {
    const asked: string[] = [];
    const list: ListModels = async (kind) => {
      asked.push(kind);
      return [{ id: 'gpt-7' }];
    };
    expect(await refreshSubscriptionModels(config, env, list)).toBe(true);
    expect(readDiscovered(env)).toEqual({ codex: [{ id: 'gpt-7' }] });
    expect(await refreshSubscriptionModels(config, env, list)).toBe(false);
    expect(asked).toEqual(['codex', 'codex']);
  });

  test('a CLI that cannot tell keeps the last answer', async () => {
    await refreshSubscriptionModels(config, env, async () => [{ id: 'gpt-7' }]);
    expect(await refreshSubscriptionModels(config, env, async () => undefined)).toBe(false);
    expect(readDiscovered(env).codex).toEqual([{ id: 'gpt-7' }]);
  });
});
