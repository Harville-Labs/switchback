import { expect, test } from 'bun:test';
import { buildSetupConfig, planModels } from './setup.ts';

test('OpenCode models share a provider per plan; Go models cost nothing per token', () => {
  const remotes = [
    { kind: 'opencode' as const, plan: 'go' as const, model: 'kimi-k3', contextWindow: 256_000 },
    { kind: 'opencode' as const, plan: 'go' as const, model: 'glm-5.3' },
    { kind: 'opencode' as const, plan: 'zen' as const, model: 'claude-sonnet-5-5' },
  ];
  const config = buildSetupConfig({ locals: [], remotes, escalationPolicy: 'auto' }) as {
    providers: Record<string, unknown>;
    models: Record<string, unknown>;
  };
  expect(config.providers).toEqual({
    'opencode-go': { type: 'opencode', plan: 'go' },
    'opencode-zen': { type: 'opencode', plan: 'zen' },
  });
  expect(config.models).toEqual({
    'kimi-k3': {
      provider: 'opencode-go',
      model: 'kimi-k3',
      contextWindow: 256_000,
      price: { input: 0, output: 0 },
    },
    'glm-5.3': { provider: 'opencode-go', model: 'glm-5.3', price: { input: 0, output: 0 } },
    // Zen's prices aren't in its model list.
    'claude-sonnet-5-5': { provider: 'opencode-zen', model: 'claude-sonnet-5-5' },
  });
  // The subscription's models come first when roles are suggested by price.
  expect(planModels({ locals: [], remotes }).map((m) => m.inputPrice)).toEqual([0, 0, undefined]);
});

test("an imported model's settings are written with it, and a variant gets its own alias", () => {
  const base = { providerId: 'vllm', baseUrl: 'http://10.0.0.5:8000/v1', model: 'lil' };
  const config = buildSetupConfig({
    locals: [
      { ...base, settings: { temperature: 1, topP: 0.95 } },
      { ...base, variant: 'direct', settings: { body: { chat_template_kwargs: { x: false } } } },
    ],
    remotes: [{ kind: 'anthropic', model: 'claude-sonnet-5', settings: { temperature: 0.2 } }],
    escalationPolicy: 'auto',
  }) as { models: Record<string, Record<string, unknown>> };
  expect(config.models.lil).toEqual({ provider: 'vllm', model: 'lil', temperature: 1, topP: 0.95 });
  expect(config.models['lil-direct']).toEqual({
    provider: 'vllm',
    model: 'lil',
    body: { chat_template_kwargs: { x: false } },
  });
  expect(config.models['claude-sonnet-5']).toMatchObject({ temperature: 0.2 });
});
