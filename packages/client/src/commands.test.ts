import { expect, test } from 'bun:test';
import {
  commandQuery,
  commandsFor,
  customCommands,
  formatCommands,
  isCustomCommand,
  matchCommands,
  SLASH_COMMANDS,
} from './commands.ts';
import { escalateNotice, formatReasoning, tailLines, toolLabel } from './format.ts';

test('command names are unique', () => {
  const names = SLASH_COMMANDS.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
});

test('each client sees only the commands it implements', () => {
  const tui = commandsFor('tui').map((c) => c.name);
  const vscode = commandsFor('vscode').map((c) => c.name);
  expect(tui).toContain('exit');
  expect(tui).not.toContain('logs');
  expect(vscode).toContain('logs');
  expect(vscode).not.toContain('exit');
  expect(vscode).toContain('compact');
});

test('name prefixes rank ahead of other matches', () => {
  const names = matchCommands('re', 'vscode').map((c) => c.name);
  expect(names.slice(0, 4)).toEqual(['remote', 'resume', 'rewind', 'review']);
  expect(names).toContain('restart');
  // Two letters don't reach into descriptions ("their tier", "reset").
  expect(names).not.toContain('models');
  // Descriptions match too, after names.
  expect(matchCommands('spend', 'tui').map((c) => c.name)).toEqual(['usage']);
  expect(matchCommands('', 'tui')).toHaveLength(commandsFor('tui').length);
  expect(matchCommands('zzz', 'tui')).toEqual([]);
});

test('formatCommands puts every description in one column', () => {
  const commands = commandsFor('tui');
  const lines = formatCommands('tui').split('\n');
  expect(lines).toHaveLength(commands.length);
  const columns = lines.map((l, i) => l.lastIndexOf(commands[i]?.description ?? '?'));
  expect(new Set(columns).size).toBe(1);
  expect(lines[0]).toStartWith('  /auto ');
});

test('commandQuery follows only a bare command name', () => {
  expect(commandQuery('/')).toBe('');
  expect(commandQuery('/rev')).toBe('rev');
  expect(commandQuery('/review on')).toBeUndefined();
  expect(commandQuery('explain /etc')).toBeUndefined();
});

test('custom commands join the menu; built-in names win', () => {
  const custom = customCommands([
    { name: 'deploy', args: '<env>', description: 'Deploy', source: 'project' },
    { name: 'help', description: 'mine', source: 'user' },
  ]);
  expect(custom.map((c) => [c.name, c.group, c.description])).toEqual([
    ['deploy', 'Custom', 'Deploy (project)'],
  ]);
  expect(matchCommands('dep', 'tui', custom).map((c) => c.name)).toEqual(['deploy']);
  expect(isCustomCommand('/deploy staging', custom)).toBe(true);
  expect(isCustomCommand('/help', custom)).toBe(false);
  expect(toolLabel('skill', { name: 'pdf', file: 'forms.py' })).toBe('skill pdf · forms.py');
});

test('reasoning reads as paragraphs, and a live preview keeps its height', () => {
  expect(formatReasoning('**Plan**\r\n\n\n\nstep one')).toBe('Plan\n\nstep one');
  expect(tailLines('one two three four five six', 9, 2)).toEqual(['four five', 'six']);
  expect(tailLines('a\n\nb', 80, 5)).toEqual(['a', '', 'b']);
});

test('escalating says when it takes effect', () => {
  expect(escalateNotice('next-step')).toContain('next step of this turn');
  expect(escalateNotice('next-prompt')).toContain('next prompt');
  expect(matchCommands('up', 'tui')[0]?.name).toBe('up');
});
