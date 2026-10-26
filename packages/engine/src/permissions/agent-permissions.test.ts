import { describe, expect, test } from 'bun:test';
import { permissionsFromList } from '../agent-permissions.ts';
import { applyAgentConfig } from '../agents.ts';
import { SwitchbackConfig } from '../config.ts';

describe("OpenCode's list form of an agent's permissions", () => {
  test('entries become levels and rules, and allow changes nothing', () => {
    const { permissions, noDelegation } = permissionsFromList([
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'shell', resource: 'git push *', effect: 'deny' },
      { action: 'edit', resource: '*', effect: 'ask' },
      { action: 'subagent', resource: '*', effect: 'deny' },
    ]);
    expect(permissions).toEqual({ edit: 'ask', deny: ['bash(git push *)'] });
    expect(noDelegation).toBe(true);
  });

  test('allowing subagents asks nothing of the agent', () => {
    const { permissions, noDelegation } = permissionsFromList([
      { action: 'subagent', resource: '*', effect: 'allow' },
    ]);
    expect(permissions).toEqual({});
    expect(noDelegation).toBe(false);
  });

  test('config accepts the list, and an agent built from it is stricter, not looser', () => {
    const config = SwitchbackConfig.parse({
      agents: {
        build: {
          permissions: [
            { action: 'edit', resource: '*', effect: 'deny' },
            { action: 'subagent', resource: '*', effect: 'allow' },
          ],
        },
      },
    });
    const build = applyAgentConfig(
      undefined,
      'build',
      { ...config.agents.build, description: 'd' },
      'config',
    );
    expect(build.permissions).toEqual({ edit: 'deny' });
    expect(build.agents).toBeUndefined();
  });
});
