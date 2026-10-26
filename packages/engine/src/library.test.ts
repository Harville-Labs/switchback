import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScriptedProvider } from '@switchback/providers';
import { applyAgentConfig } from './agents.ts';
import { SwitchbackConfig } from './config.ts';
import { expandCommand, loadCustomCommands } from './custom-commands.ts';
import { Engine } from './engine.ts';
import { Library, type LibraryDirs } from './library.ts';
import { loadSkills, skillsSection } from './skills.ts';
import { skillTool } from './tools/skill.ts';
import type { ToolContext } from './tools/tool.ts';

let root: string;
let dirs: LibraryDirs;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-lib-'));
  dirs = {
    commands: [
      { dir: join(root, 'user', 'commands'), source: 'user' },
      { dir: join(root, 'project', 'commands'), source: 'project' },
    ],
    skills: [
      { dir: join(root, 'user', 'skills'), source: 'user' },
      { dir: join(root, 'project', 'skills'), source: 'project' },
    ],
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(path: string, text: string) {
  const file = join(root, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}

describe('custom commands', () => {
  test('frontmatter, arguments, and a project command overriding yours', () => {
    put('user/commands/review.md', 'Review everything.');
    put(
      'project/commands/review.md',
      '---\ndescription: Review a file\nargs: <file> [focus]\n---\nReview $1, focusing on $2. All: $ARGUMENTS',
    );
    put('project/commands/Bad Name.md', 'x');
    const { commands, errors } = loadCustomCommands(dirs.commands);
    expect(commands.get('review')).toMatchObject({
      description: 'Review a file',
      args: '<file> [focus]',
      source: 'project',
    });
    expect(errors).toHaveLength(1);
    expect(expandCommand('/review a.ts tests', commands)).toBe(
      'Review a.ts, focusing on tests. All: a.ts tests',
    );
    expect(expandCommand('/review', commands)).toBe('Review , focusing on . All: ');
    expect(expandCommand('/unknown x', commands)).toBeUndefined();
    expect(expandCommand('not a command', commands)).toBeUndefined();
  });

  test('without frontmatter the first line describes it', () => {
    put('user/commands/hi.md', 'Say hello\nthen stop.');
    expect(loadCustomCommands(dirs.commands).commands.get('hi')?.description).toBe('Say hello');
  });
});

describe('skills', () => {
  const ctx = (skills: ReturnType<typeof loadSkills>['skills']) =>
    ({ skills: () => skills }) as unknown as ToolContext;

  test('loads SKILL.md folders and lists names and descriptions', () => {
    put(
      'user/skills/pdf/SKILL.md',
      '---\nname: pdf\ndescription: Fill PDF forms\n---\nUse forms.py',
    );
    put('project/skills/nodesc/SKILL.md', '---\nname: nodesc\n---\nbody');
    const { skills, errors } = loadSkills(dirs.skills);
    expect([...skills.keys()]).toEqual(['pdf']);
    expect(errors[0]).toContain('needs a description');
    expect(skillsSection(skills.values())).toContain('- pdf: Fill PDF forms');
    expect(skillsSection([])).toBeUndefined();
  });

  test('the skill tool loads instructions and files, and stays in the folder', async () => {
    put(
      'user/skills/pdf/SKILL.md',
      '---\nname: pdf\ndescription: Fill PDF forms\n---\nUse forms.py',
    );
    put('user/skills/pdf/scripts/forms.py', 'print(1)');
    put('user/secret.txt', 'secret');
    symlinkSync(join(root, 'user/secret.txt'), join(root, 'user/skills/pdf/link.txt'));
    const { skills } = loadSkills(dirs.skills);
    const loaded = await skillTool.run({ name: 'pdf' }, ctx(skills));
    expect(loaded).toContain('Use forms.py');
    expect(loaded).toContain('- scripts/forms.py');
    expect(await skillTool.run({ name: 'pdf', file: 'scripts/forms.py' }, ctx(skills))).toBe(
      'print(1)',
    );
    await expect(
      skillTool.run({ name: 'pdf', file: '../../secret.txt' }, ctx(skills)),
    ).rejects.toThrow();
    await expect(skillTool.run({ name: 'pdf', file: 'link.txt' }, ctx(skills))).rejects.toThrow();
    await expect(skillTool.run({ name: 'nope' }, ctx(skills))).rejects.toThrow('no skill named');
  });
});

describe('the engine', () => {
  function setup() {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { current: ['local'] },
    });
    const lp = new ScriptedProvider('lp', 'local', [{ text: 'done' }]);
    const engine = new Engine({
      workspaceRoot: root,
      config,
      providers: new Map([['lp', lp]]),
      library: dirs,
    });
    return { engine, lp };
  }

  test('lists commands and expands one sent as a prompt', async () => {
    put('project/commands/fix.md', '---\ndescription: Fix an issue\n---\nFix issue #$1.');
    const { engine } = setup();
    expect(await engine.listCommands()).toEqual([
      { name: 'fix', description: 'Fix an issue', source: 'project' },
    ]);
    const s = engine.createSession({});
    const done = new Promise<void>((resolve) =>
      engine.subscribe((e) => e.type === 'turn.completed' && resolve()),
    );
    engine.prompt({ sessionId: s.id, text: '/fix 12' });
    await done;
    expect(engine.getSession(s.id).messages[0]?.parts).toEqual([
      { type: 'text', text: 'Fix issue #12.' },
    ]);
  });

  test('puts skills in the system prompt and offers the skill tool', async () => {
    put('user/skills/pdf/SKILL.md', '---\nname: pdf\ndescription: Fill PDF forms\n---\nbody');
    const { engine, lp } = setup();
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'hi');
    expect(lp.requests[0]?.system).toContain('- pdf: Fill PDF forms');
    expect(lp.requests[0]?.tools?.map((t) => t.name)).toContain('skill');
  });
});

describe('commands in config', () => {
  const config = SwitchbackConfig.parse({
    commands: {
      'team-issue': {
        description: 'Open an issue',
        template: 'Create an issue for: $ARGUMENTS',
        args: '<title>',
      },
      review: { template: 'Review from config.' },
      'Bad Name': { template: 'x' },
    },
  });

  test('expand like files, win over a file of the same name, and report a bad name once', () => {
    put('project/commands/review.md', 'Review from a file.');
    const warnings: string[] = [];
    const library = new Library(
      dirs,
      (m) => warnings.push(m),
      () => config.commands,
    );
    expect(library.expand('/team-issue fix retries')).toBe('Create an issue for: fix retries');
    expect(library.expand('/review')).toBe('Review from config.');
    expect(library.listCommands().find((c) => c.name === 'team-issue')).toEqual({
      name: 'team-issue',
      description: 'Open an issue',
      args: '<title>',
      source: 'config',
    });
    library.commands();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Bad Name');
  });

  test('an OpenCode-style agent entry works as written: system is the prompt, steps the limit', () => {
    const parsed = SwitchbackConfig.parse({
      agents: {
        researcher: { description: 'Research', mode: 'subagent', system: 'Be brief.', steps: 12 },
      },
    });
    const agent = applyAgentConfig(
      undefined,
      'researcher',
      parsed.agents.researcher ?? {},
      'config',
    );
    expect(agent).toMatchObject({ prompt: 'Be brief.', maxSteps: 12, mode: 'subagent' });
  });
});

describe('commands that hand off to a subagent', () => {
  test('subagent: true wraps the prompt so the model delegates it, to the named agent or general', () => {
    const config = SwitchbackConfig.parse({
      commands: {
        triage: { template: 'Triage $1', subagent: true, agent: 'researcher' },
        plain: { template: 'Do $1', subagent: true },
        here: { template: 'Do $1', subagent: false },
      },
    });
    const library = new Library(
      dirs,
      () => {},
      () => config.commands,
    );
    expect(library.expand('/triage bug-12')).toBe(
      'Use the task tool to hand the following to the researcher subagent, then tell me what it found or did.\n\nTriage bug-12',
    );
    expect(library.expand('/plain x')).toContain('the general subagent');
    expect(library.expand('/here x')).toBe('Do x');
  });

  test('a command file can say so in its frontmatter', () => {
    put('project/commands/dig.md', '---\nsubagent: true\nagent: explore\n---\nFind $1');
    const library = new Library(dirs, () => {});
    expect(library.expand('/dig parser')).toContain('the explore subagent');
  });
});
