import { describe, expect, test } from 'bun:test';
import {
  type AgentDefinition,
  applyAgentConfig,
  BUILTIN_AGENTS,
  canDelegate,
  parseAgentFile,
  reasoningEffort,
} from './agents.ts';
import { SwitchbackConfig } from './config.ts';
import { taskModelProblem } from './subagents.ts';

const config = SwitchbackConfig.parse({
  providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
  models: {
    small: { provider: 'lp', model: 'small', effort: 'medium' },
    big: { provider: 'rp', model: 'big' },
  },
  subagents: { effort: 'low' },
});

const agent = (fields: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'a',
  description: 'd',
  prompt: '',
  mode: 'all',
  route: 'auto',
  source: 'project',
  ...fields,
});

describe('agent files', () => {
  test('read mode, effort, step limit, and the agents it may call', () => {
    const parsed = parseAgentFile(
      '---\ndescription: d\nmode: subagent\neffort: high\nmaxSteps: 12\nagents: explore, review-*\n---\nx',
      'a.md',
      'project',
    );
    expect(parsed).toMatchObject({
      mode: 'subagent',
      effort: 'high',
      maxSteps: 12,
      agents: ['explore', 'review-*'],
    });
  });

  test('default to mode all with no effort of their own', () => {
    const parsed = parseAgentFile('---\ndescription: d\n---\nx', 'a.md', 'project');
    expect(parsed.mode).toBe('all');
    expect(parsed.effort).toBeUndefined();
  });

  test('name the file and field when a value is wrong', () => {
    expect(() =>
      parseAgentFile('---\ndescription: d\neffort: extreme\n---\nx', 'a.md', 'project'),
    ).toThrow(/a\.md: effort/);
    expect(() => parseAgentFile('---\nmode: subagent\n---\nx', 'b.md', 'project')).toThrow(
      /needs a description/,
    );
  });
});

describe('config agents', () => {
  test('change only the fields they set on an existing agent', () => {
    const explore = BUILTIN_AGENTS.find((a) => a.name === 'explore');
    const tuned = applyAgentConfig(explore, 'explore', { effort: 'high' }, 'config');
    expect(tuned).toMatchObject({ effort: 'high', mode: 'subagent', route: 'local' });
    expect(tuned.prompt).toBe(explore?.prompt ?? '');
    expect(tuned.source).toBe('config');
  });

  test('model inherit drops an earlier pin', () => {
    const pinned = agent({ model: 'big' });
    expect(applyAgentConfig(pinned, 'a', { model: 'inherit' }, 'config').model).toBeUndefined();
  });

  test('a new agent needs a description', () => {
    expect(() => applyAgentConfig(undefined, 'x', { prompt: 'p' }, 'config')).toThrow(
      'agent "x" needs a description',
    );
  });
});

describe('delegation', () => {
  test('an agent without a list may call any subagent but never a primary one', () => {
    expect(canDelegate(agent(), agent({ name: 'explore' }))).toBe(true);
    expect(canDelegate(agent(), agent({ name: 'build', mode: 'primary' }))).toBe(false);
  });

  test('a list limits calls to the names and globs it gives', () => {
    const lead = agent({ agents: ['explore', 'review-*'] });
    expect(canDelegate(lead, agent({ name: 'explore' }))).toBe(true);
    expect(canDelegate(lead, agent({ name: 'review-security' }))).toBe(true);
    expect(canDelegate(lead, agent({ name: 'general' }))).toBe(false);
    expect(canDelegate(agent({ agents: [] }), agent({ name: 'explore' }))).toBe(false);
  });
});

describe('reasoning effort', () => {
  test('the task call wins, then the session, the agent, the subagent default, the model', () => {
    const top = { depth: 0 };
    const child = { depth: 1 };
    expect(reasoningEffort(config, agent(), 'small', top)).toBe('medium');
    expect(reasoningEffort(config, agent(), 'big', top)).toBeUndefined();
    expect(reasoningEffort(config, agent(), 'small', child)).toBe('low');
    expect(reasoningEffort(config, agent({ effort: 'high' }), 'small', child)).toBe('high');
    expect(
      reasoningEffort(config, agent({ effort: 'high' }), 'small', { depth: 0, effort: 'max' }),
    ).toBe('max');
    expect(
      reasoningEffort(config, agent({ effort: 'high' }), 'small', {
        depth: 1,
        task: { effort: 'none' },
      }),
    ).toBe('none');
  });
});

describe('per-task model', () => {
  test('must be a configured alias', () => {
    expect(taskModelProblem(config, agent(), 'huge')).toBe(
      'unknown model "huge"; configured models: small, big',
    );
    expect(taskModelProblem(config, agent(), 'big')).toBeUndefined();
  });

  test('cannot move a local-only agent to a remote model', () => {
    expect(taskModelProblem(config, agent({ route: 'local' }), 'small')).toBeUndefined();
    expect(taskModelProblem(config, agent({ route: 'local' }), 'big')).toContain('stays local');
  });

  test('is refused for agents on an external runtime', () => {
    expect(taskModelProblem(config, agent({ runtime: 'claude' }), 'small')).toContain(
      'chooses its own model',
    );
  });
});
