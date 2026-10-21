import { expect, test } from 'bun:test';
import { BUILTIN_AGENTS } from './agents.ts';
import { systemPrompt } from './system-prompt.ts';

const parts = { workspaceRoot: '/w', root: '/w', shell: 'bash' };
const agent = (name: string) => {
  const a = BUILTIN_AGENTS.find((x) => x.name === name);
  if (!a) throw new Error(`no built-in agent ${name}`);
  return a;
};

test('every session is told how to use subagents, escalation, and the docs', () => {
  const prompt = systemPrompt({ ...parts, agent: agent('build') });
  expect(prompt).toContain('# Working in Switchback');
  expect(prompt).toContain('(task)');
  expect(prompt).toContain('(escalate)');
  expect(prompt).toContain('(docs)');
});

test('an agent without the task tool is not told about subagents', () => {
  const prompt = systemPrompt({ ...parts, agent: agent('explore') });
  expect(prompt).toContain('(escalate)');
  expect(prompt).not.toContain('(task)');
});
