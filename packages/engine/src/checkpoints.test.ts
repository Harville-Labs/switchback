import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Script, ScriptedProvider } from '@switchback/providers';
import { Checkpoints, FileCheckpointStore, MemoryCheckpointStore } from './checkpoints.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-cp-'));
  writeFileSync(join(root, 'a.txt'), 'one\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('checkpoints', () => {
  for (const [name, make] of [
    ['in memory', () => new MemoryCheckpointStore()],
    ['on disk', () => new FileCheckpointStore(join(root, '.cp'))],
  ] as const) {
    test(`restore files changed since a checkpoint (${name})`, () => {
      const cp = new Checkpoints(make());
      cp.begin('s', 't1', 0, 'first', 'now');
      cp.note('s', join(root, 'a.txt'), 'a.txt');
      writeFileSync(join(root, 'a.txt'), 'two\n');
      cp.begin('s', 't2', 2, 'second', 'now');
      cp.note('s', join(root, 'a.txt'), 'a.txt');
      writeFileSync(join(root, 'a.txt'), 'three\n');
      cp.note('s', join(root, 'b.txt'), 'b.txt');
      writeFileSync(join(root, 'b.txt'), 'new\n');

      expect(cp.list('s').map((c) => [c.turnId, c.files])).toEqual([
        ['t1', ['a.txt']],
        ['t2', ['a.txt', 'b.txt']],
      ]);
      // Back to the start of t2: a.txt as t1 left it, b.txt gone.
      expect(cp.restoreFiles('s', 't2', root).sort()).toEqual(['a.txt', 'b.txt']);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two\n');
      expect(existsSync(join(root, 'b.txt'))).toBe(false);
      // Back to the start of t1: the original.
      cp.restoreFiles('s', 't1', root);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    });
  }
});

describe('rewinding a session', () => {
  function setup(script: Script) {
    const config = SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { local: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { start: ['local'] },
      permissions: { edit: 'allow' },
    });
    const lp = new ScriptedProvider('lp', 'local', script);
    return new Engine({ workspaceRoot: root, config, providers: new Map([['lp', lp]]) });
  }
  const write = (content: string) => ({
    toolCalls: [{ name: 'write', input: { path: 'a.txt', content } }],
  });

  test('files go back; the conversation forks and the original is kept', async () => {
    const engine = setup([
      write('two\n'),
      { text: 'did one' },
      write('three\n'),
      { text: 'did two' },
    ]);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'first change');
    await engine.runTurn(s.id, 'second change');
    const checkpoints = engine.listCheckpoints(s.id);
    expect(checkpoints.map((c) => c.prompt)).toEqual(['first change', 'second change']);
    const second = checkpoints[1]?.turnId as string;

    const r = engine.rewind({ sessionId: s.id, turnId: second, restore: 'both' });
    expect(r.files).toEqual(['a.txt']);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two\n');
    const fork = engine.getSession(r.session?.id as string);
    const original = engine.getSession(s.id);
    // The fork ends before the rewound prompt; the original still has everything.
    expect(fork.messages).toEqual(original.messages.slice(0, checkpoints[1]?.index));
    expect(original.messages.length).toBeGreaterThan(fork.messages.length);
  });

  test('only the conversation leaves files alone', async () => {
    const engine = setup([write('two\n'), { text: 'ok' }]);
    const s = engine.createSession({});
    await engine.runTurn(s.id, 'change it');
    const [first] = engine.listCheckpoints(s.id);
    const r = engine.rewind({
      sessionId: s.id,
      turnId: first?.turnId as string,
      restore: 'conversation',
    });
    expect(r.files).toEqual([]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('two\n');
    expect(engine.getSession(r.session?.id as string).messages).toEqual([]);
  });

  test('an unknown checkpoint is refused', () => {
    const engine = setup([]);
    const s = engine.createSession({});
    expect(() => engine.rewind({ sessionId: s.id, turnId: 'nope', restore: 'files' })).toThrow(
      'no checkpoint nope',
    );
  });
});
