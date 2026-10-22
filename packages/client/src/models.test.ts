import { expect, test } from 'bun:test';
import type { InitializeResult, SessionRoles } from '@switchback/protocol';
import { formatModels, MODELS_HINT } from './format.ts';
import { choiceLabel, currentChange, formatRefresh, modelChoices, nextModel } from './models.ts';

const models: InitializeResult['models'] = [
  { alias: 'fast', ref: { provider: 'ollama', model: 'qwen3' }, tier: 'local' },
  { alias: 'large', ref: { provider: 'gpu', model: 'qwen3-480b' }, tier: 'local' },
  { alias: 'opus', ref: { provider: 'anthropic', model: 'claude-opus-5' }, tier: 'remote' },
];
const roles: SessionRoles = {
  current: ['large', 'fast'],
  escalate: [['opus']],
  review: { mode: 'auto', models: [] },
  overridden: [],
};

test('the current model is listed first, with the other roles each model fills', () => {
  const choices = modelChoices(models, roles);
  expect(choices.map((c) => [c.alias, c.current])).toEqual([
    ['large', true],
    ['fast', false],
    ['opus', false],
  ]);
  // A backup is still part of the current chain, so it's not listed as another role.
  expect(choices[1]?.roles).toEqual([]);
  expect(choiceLabel(choices[2] as (typeof choices)[number])).toBe(
    'opus (claude-opus-5) · remote · step 1',
  );
});

test('picking a model keeps the previous ones as backups, in order', () => {
  expect(currentChange(roles, 'opus')).toEqual({ current: ['opus', 'large', 'fast'] });
  expect(currentChange(roles, 'fast')).toEqual({ current: ['fast', 'large'] });
  expect(currentChange(undefined, 'fast')).toEqual({ current: ['fast'] });
});

test('choosing the subagent model lists the one subagents use first', () => {
  const choices = modelChoices(models, { ...roles, subagents: 'fast' }, 'subagents');
  expect(choices.map((c) => [c.alias, c.current])).toEqual([
    ['fast', true],
    ['large', false],
    ['opus', false],
  ]);
  expect(choices[0]?.roles).toEqual(['current']);
});

test("the next model takes the current one's place, in config order, wrapping around", () => {
  expect(nextModel(models, roles)).toEqual({
    alias: 'opus',
    change: { current: ['opus', 'fast'] },
  });
  const last = { ...roles, current: ['opus', 'fast'] };
  expect(nextModel(models, last)).toEqual({ alias: 'fast', change: { current: ['fast'] } });
  expect(nextModel(models, undefined)?.alias).toBe('fast');
});

test('tab goes round the chosen models only, not every model an endpoint lists', () => {
  const served: InitializeResult['models'] = [
    ...models,
    {
      alias: 'llama-70b',
      ref: { provider: 'gpu', model: 'llama-70b' },
      tier: 'local',
      listed: true,
    },
    { alias: 'mistral', ref: { provider: 'gpu', model: 'mistral' }, tier: 'local', listed: true },
  ];
  const last = { ...roles, current: ['opus'] };
  expect(nextModel(served, last)?.alias).toBe('fast');
  // Once a role uses a listed model, it's chosen.
  expect(nextModel(served, { ...last, current: ['mistral'] })?.alias).toBe('fast');
  expect(nextModel(served, { ...last, escalate: [['mistral']] })?.alias).toBe('mistral');
  // Pickers still offer listed models, after the chosen ones.
  const choices = modelChoices(served, roles);
  expect(choices.map((c) => c.alias)).toEqual(['large', 'fast', 'opus', 'llama-70b', 'mistral']);
  expect(choiceLabel(choices[4] as (typeof choices)[number])).toBe('mistral · local · listed');
});

test('there is no next model when only one is set up', () => {
  expect(nextModel(models.slice(0, 1), { ...roles, current: ['fast'] })).toBeUndefined();
});

test("a refresh says what each source lists now, and one it couldn't ask keeps its list", () => {
  expect(
    formatRefresh({
      models,
      sources: [
        { provider: 'gpu', added: ['qwen3-480b'], removed: ['qwen2'] },
        { provider: 'ollama', added: [], removed: [], error: 'connection refused' },
        { provider: 'codex', added: [], removed: [] },
      ],
    }),
  ).toBe(
    [
      '3 models available.',
      '  gpu: new qwen3-480b; gone qwen2',
      "  ollama: couldn't ask (connection refused); its last list stays",
      '  codex: no change',
    ].join('\n'),
  );
  expect(formatRefresh({ models, sources: [] })).toStartWith('Nothing to refresh');
});

test('the model list lines up its columns, marks models an endpoint listed, and says how to refresh', () => {
  const all = [
    ...models,
    {
      alias: 'mistral',
      ref: { provider: 'lan', model: 'mistral' },
      tier: 'local' as const,
      listed: true as const,
    },
  ];
  const text = formatModels(all, roles);
  expect(text).toContain('mistral  mistral (local)  · listed by its endpoint');
  expect(text).toContain('fast     qwen3 (local)');
  expect(text.split('\n').at(-1)).toBe(MODELS_HINT);
});
