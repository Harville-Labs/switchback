import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolResultPart } from '@switchback/protocol';
import { type Provider, type Script, ScriptedProvider } from '@switchback/providers';
import { SwitchbackConfig } from './config.ts';
import { attachmentChars, fitResult, MIN_RESULT_CHARS, resultChars } from './context-budget.ts';
import { Engine } from './engine.ts';
import { MAX_RESULT_CHARS } from './tools/index.ts';

describe('budgets', () => {
  test('a small window gets a share of it; a large one keeps the fixed ceiling', () => {
    expect(resultChars(8_192, 1, MAX_RESULT_CHARS)).toBe(6_144);
    expect(resultChars(200_000, 1, MAX_RESULT_CHARS)).toBe(MAX_RESULT_CHARS);
  });

  test('parallel results split the share, down to a floor', () => {
    expect(resultChars(32_000, 4, MAX_RESULT_CHARS)).toBe(6_000);
    expect(resultChars(8_192, 10, MAX_RESULT_CHARS)).toBe(MIN_RESULT_CHARS);
  });

  test('a cut result keeps its start and its end', () => {
    const text = `start ${'x'.repeat(10_000)} end`;
    const cut = fitResult(text, 5_000, 'ask for less');
    expect(cut.startsWith('start ')).toBe(true);
    expect(cut.endsWith(' end')).toBe(true);
    expect(cut).toContain(`[${text.length - 5_000} characters left out here; ask for less]`);
    expect(fitResult('short', 5_000, 'ask for less')).toBe('short');
  });

  test('attachments take half the window, and only the ceiling when it is unknown', () => {
    expect(attachmentChars(8_192, 500_000)).toBe(12_288);
    expect(attachmentChars(1_000_000, 500_000)).toBe(500_000);
    expect(attachmentChars(undefined, 500_000)).toBe(500_000);
  });
});

describe('the engine fits new content to the window', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sb-budget-'));
    writeFileSync(join(root, 'big.txt'), `${'line of text\n'.repeat(4_000)}`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function engine(contextWindow: number, script: Script) {
    const local = new ScriptedProvider('lp', 'local', script);
    const e = new Engine({
      workspaceRoot: root,
      config: SwitchbackConfig.parse({
        providers: { lp: { type: 'mock', tier: 'local' } },
        models: { local: { provider: 'lp', model: 'small', contextWindow } },
        routing: { current: ['local'] },
      }),
      providers: new Map<string, Provider>([['lp', local]]),
    });
    return { e, local };
  }
  const results = (messages: Message[]) =>
    messages.flatMap((m) => m.parts.filter((p): p is ToolResultPart => p.type === 'tool_result'));
  const readTwice: Script = [
    {
      toolCalls: [
        { name: 'read', input: { path: 'big.txt' } },
        { name: 'read', input: { path: 'big.txt', offset: 2_000 } },
      ],
    },
    { text: 'done' },
  ];

  test('on a small window, parallel reads share a quarter of it', async () => {
    const { e } = engine(16_000, readTwice);
    const s = e.createSession({});
    await e.runTurn(s.id, 'read it');
    const [a, b] = results(e.getSession(s.id).messages);
    for (const r of [a, b]) {
      expect(r?.content.startsWith('     1\t') || r?.content.startsWith('  2000\t')).toBe(true);
      expect(r?.content).toContain("to fit the model's context window");
      expect(r?.content.length).toBeLessThan(6_000 + 200);
      // The end survives: it says how much of the file the read left out.
      expect(r?.content).toMatch(/\[\d+ more lines\]$| {2}4000\t/);
    }
  });

  test('on a large window, a read keeps up to the fixed ceiling', async () => {
    const { e } = engine(1_000_000, readTwice);
    const s = e.createSession({});
    await e.runTurn(s.id, 'read it');
    const [a] = results(e.getSession(s.id).messages);
    expect(a?.content.length).toBeGreaterThan(MAX_RESULT_CHARS - 100);
    expect(a?.content.length).toBeLessThan(MAX_RESULT_CHARS + 200);
  });

  test('a mention too large for the window is left for the read tool', async () => {
    for (const [window, attached] of [
      [8_192, false],
      [1_000_000, true],
    ] as const) {
      const { e, local } = engine(window, [{ text: 'ok' }]);
      const s = e.createSession({});
      await e.runTurn(s.id, 'look at @big.txt');
      const prompt = JSON.stringify(local.requests[0]?.messages.at(-1));
      expect(prompt.includes('use the read tool')).toBe(!attached);
      expect(prompt.includes('line of text')).toBe(attached);
    }
  });
});
