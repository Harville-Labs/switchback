import { expect, test } from 'bun:test';
import type { InitializeResult, SessionRoles } from '@switchback/protocol';
import { choiceLabel, currentChange, modelChoices, nextModel } from './models.ts';

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

test('there is no next model when only one is set up', () => {
  expect(nextModel(models.slice(0, 1), { ...roles, current: ['fast'] })).toBeUndefined();
});
