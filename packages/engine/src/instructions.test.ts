import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { instructionsUsage, readInstructions } from './instructions.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-instructions-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("your AGENTS.md comes before the project's, and both reach subagents", async () => {
  const lp = new ScriptedProvider('lp', 'local', [
    {
      toolCalls: [{ name: 'task', input: { agent: 'explore', prompt: 'look', description: 'd' } }],
    },
    { text: 'found' },
    { text: 'done' },
  ]);
  const engine = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { m: { provider: 'lp', model: 'small', contextWindow: 8_000 } },
      routing: { start: ['m'] },
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
    userInstructions: 'Use plain words.\n',
    instructions: 'Run bun run check.\n',
  });
  await engine.runTurn(engine.createSession({}).id, 'go');
  expect(lp.requests).toHaveLength(3);
  for (const { system } of lp.requests) {
    const user = system.indexOf('# User instructions (every project)\nUse plain words.');
    const project = system.indexOf('# Project instructions\nRun bun run check.');
    expect(user).toBeGreaterThan(-1);
    expect(project).toBeGreaterThan(user);
  }
});

test('a missing or blank AGENTS.md adds no instructions', () => {
  writeFileSync(join(root, 'blank.md'), '\n  \n');
  writeFileSync(join(root, 'AGENTS.md'), '# Rules\n');
  expect(readInstructions(join(root, 'missing.md'))).toBeUndefined();
  expect(readInstructions(join(root, 'blank.md'))).toBeUndefined();
  expect(readInstructions(join(root, 'AGENTS.md'))).toBe('# Rules\n');
});

test('instructions over a tenth of the smallest window get a warning that says what to do', () => {
  const files = [
    { scope: 'user' as const, path: '/home/me/.switchback/AGENTS.md', text: 'word '.repeat(500) },
    { scope: 'project' as const, path: '/work/AGENTS.md', text: 'word '.repeat(400) },
  ];
  const big = instructionsUsage(files, [200_000, 8_000]);
  expect(big.files.map((f) => f.scope)).toEqual(['user', 'project']);
  expect(big.total).toBe(big.files[0]!.tokens + big.files[1]!.tokens);
  expect(big.window).toBe(8_000);
  expect(big.warning).toContain('of the smallest context window (8,000 tokens)');
  expect(big.warning).toContain('skills');
  expect(instructionsUsage(files, [200_000]).warning).toBeUndefined();
  // No known window: counts only.
  expect(instructionsUsage(files, [])).not.toHaveProperty('window');
});
