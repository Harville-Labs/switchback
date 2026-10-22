import { expect, test } from 'bun:test';
import { formatAgentChoices, nextAgent, parseLevel, switchableAgents } from './levels.ts';

const agents = [
  { name: 'review', mode: 'subagent', description: 'reviews' },
  { name: 'zed', mode: 'all', description: 'custom z' },
  { name: 'plan', mode: 'primary', description: 'plans' },
  { name: 'careful', mode: 'primary', description: 'custom c' },
  { name: 'build', mode: 'primary', description: 'builds' },
  { name: 'explore', mode: 'subagent', description: 'searches' },
] as const;

test('Shift+Tab order is build, plan, then custom agents by name; subagents are left out', () => {
  expect(switchableAgents([...agents]).map((a) => a.name)).toEqual([
    'build',
    'plan',
    'careful',
    'zed',
  ]);
});

test('cycling wraps from the last agent to build, and goes nowhere with one agent', () => {
  expect(nextAgent([...agents], 'build')).toBe('plan');
  expect(nextAgent([...agents], 'zed')).toBe('build');
  // An agent that can't lead (a resumed subagent-only name) starts the cycle over.
  expect(nextAgent([...agents], 'explore')).toBe('build');
  expect(nextAgent([{ name: 'build', mode: 'primary' }], 'build')).toBeUndefined();
});

test('/agent marks the current agent and lines up descriptions', () => {
  const lines = formatAgentChoices([...agents], 'plan').split('\n');
  expect(lines.slice(0, 4)).toEqual([
    '  build    builds',
    '● plan     plans',
    '  careful  custom c',
    '  zed      custom z',
  ]);
});

test('levels parse from their names and from the old permission mode names', () => {
  expect(
    ['ask', 'default', 'auto', 'autoApprove', 'auto-approve', 'bypass', 'bypassPermissions'].map(
      parseLevel,
    ),
  ).toEqual(['ask', 'ask', 'auto', 'auto', 'auto', 'bypass', 'bypass']);
  // acceptEdits and plan aren't levels any more: one is a config setting, the other an agent.
  expect(parseLevel('acceptEdits')).toBeUndefined();
  expect(parseLevel('plan')).toBeUndefined();
});
