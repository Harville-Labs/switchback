import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { Prompter } from './prompt.ts';

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ENTER = '\r';
const SPACE = ' ';

/** A Prompter on in-memory streams, and a way to type into it. */
function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (chunk) => {
    screen += chunk.toString();
  });
  const type = async (...keys: string[]) => {
    for (const k of keys) {
      await Bun.sleep(5);
      input.write(k);
    }
  };
  return { p: new Prompter({ input, output }), type, screen: () => screen };
}

const options = [
  { label: 'User config', value: 'user' },
  { label: 'Project config', value: 'project', hint: '.switchback/config.json' },
];

describe('prompts', () => {
  test('select moves with the arrow keys', async () => {
    const t = terminal();
    const answer = t.p.select('Where?', options);
    await t.type(DOWN, ENTER);
    expect(await answer).toBe('project');
    expect(t.screen()).toContain('.switchback/config.json');
  });

  test('select stops at the ends of the list instead of wrapping around', async () => {
    const t = terminal();
    const answer = t.p.select('Where?', options);
    await t.type(UP, ENTER);
    expect(await answer).toBe('user');
    const u = terminal();
    const last = u.p.select('Where?', options);
    await u.type(DOWN, DOWN, DOWN, ENTER);
    expect(await last).toBe('project');
  });

  test('select starts on the default', async () => {
    const t = terminal();
    const answer = t.p.select('Where?', options, 1);
    await t.type(ENTER);
    expect(await answer).toBe('project');
  });

  test('search filters as you type and can keep what was typed', async () => {
    const models = ['openai/gpt-6-sol', 'deepseek/deepseek-flash', 'qwen/qwen3-coder'].map(
      (id) => ({
        label: id,
        value: id,
      }),
    );
    const t = terminal();
    const picked = t.p.search('Model?', models, { freeText: true });
    await t.type(...'dsflash', ENTER);
    expect(await picked).toBe('deepseek/deepseek-flash');

    const u = terminal();
    const typed = u.p.search('Model?', models, { freeText: true });
    await u.type(...'my-finetune', ENTER);
    expect(await typed).toBe('my-finetune');
  });

  test('multiSelect toggles with space, keeping what starts checked', async () => {
    const t = terminal();
    const answer = t.p.multiSelect('Presets?', [
      { label: 'Bun', value: 'bun', checked: true },
      { label: 'Go', value: 'go' },
    ]);
    await t.type(DOWN, SPACE, ENTER);
    expect(await answer).toEqual(['bun', 'go']);
  });

  test('number accepts separators and falls back to the default', async () => {
    const t = terminal();
    const n = t.p.number('Context?', 32_768);
    await t.type(...'128,000', ENTER);
    expect(await n).toBe(128_000);
    const u = terminal();
    const d = u.p.number('Context?', 32_768);
    await u.type(ENTER);
    expect(await d).toBe(32_768);
  });
});
