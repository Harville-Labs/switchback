import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SwitchbackClient } from '@switchback/client';
import type { EngineEvent, SetupAnswerParams, SetupQuestion } from '@switchback/protocol';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { useEffect } from 'react';
import { SetupQuestionPanel, setupEnded, useSetup } from './SetupPanel.tsx';
import { frameWith, frameWithout, tick, until } from './test-support.ts';

const DOWN = '\x1b[B';
const ESC = '\x1b';

/** Draw `question`, type `keys` one at a time, and return what it answered. */
async function answer(question: SetupQuestion, keys: string[]) {
  const got: SetupAnswerParams['value'][] = [];
  const ui = render(<SetupQuestionPanel question={question} onAnswer={(v) => got.push(v)} />);
  await frameWith(ui, question.question);
  for (const k of keys) {
    ui.stdin.write(k);
    await tick();
  }
  const frame = ui.lastFrame() ?? '';
  ui.unmount();
  return { got, frame };
}

const opts = (...labels: string[]) => labels.map((label) => ({ label }));

describe('setup in the TUI', () => {
  test('a select starts on its default and answers the chosen index', async () => {
    const q: SetupQuestion = {
      kind: 'select',
      question: 'Which?',
      options: opts('a', 'b', 'c'),
      default: 1,
    };
    expect((await answer(q, ['\r'])).got).toEqual([1]);
    expect((await answer(q, [DOWN, '\r'])).got).toEqual([2]);
  });

  test('a confirm answers true or false, by list or by letter', async () => {
    const q: SetupQuestion = { kind: 'confirm', question: 'Local?', default: false };
    expect((await answer(q, ['\r'])).got).toEqual([false]);
    expect((await answer(q, ['y'])).got).toEqual([true]);
  });

  test('a multi-select keeps what starts ticked and toggles with space', async () => {
    const q: SetupQuestion = {
      kind: 'multiSelect',
      question: 'Which models?',
      options: [{ label: 'a', checked: true }, { label: 'b' }, { label: 'c' }],
    };
    expect((await answer(q, [DOWN, ' ', '\r'])).got).toEqual([[0, 1]]);
  });

  test('a search filters as you type and can take what was typed', async () => {
    const options = opts('llama-3', 'qwen-coder', 'qwen-math');
    const q: SetupQuestion = { kind: 'search', question: 'Model?', options, freeText: true };
    const coder = await answer(q, [...'coder', '\r']);
    expect(coder.got).toEqual([1]);
    expect((await answer(q, [...'zzz', '\r'])).got).toEqual(['zzz']);
  });

  test('a secret is hidden as it is typed', async () => {
    const q: SetupQuestion = { kind: 'text', question: 'API key', secret: true };
    const { got, frame } = await answer(q, [...'sk-1', '\r']);
    expect(frame).not.toContain('sk-1');
    expect(got).toEqual(['sk-1']);
  });

  test('a text default is a suggestion: typing replaces it and enter on empty takes it', async () => {
    const q: SetupQuestion = { kind: 'text', question: 'Endpoint URL', default: 'http://x:1/v1' };
    const typed = await answer(q, [...'http://gpu:8000/v1', '\r']);
    expect(typed.got).toEqual(['http://gpu:8000/v1']);
    expect((await answer(q, ['\r'])).got).toEqual(['']);
  });

  test('a number takes empty for its default and refuses what is not a number', async () => {
    const q: SetupQuestion = { kind: 'number', question: 'Context window', default: 32768 };
    expect((await answer(q, ['\r'])).got).toEqual(['']);
    const bad = await answer(q, [...'lots', '\r']);
    expect(bad.got).toEqual([]);
    expect(bad.frame).toContain('Enter a positive number');
    expect((await answer(q, [...'65,536', '\r'])).got).toEqual([65536]);
  });

  test('esc on any question cancels setup', async () => {
    expect((await answer({ kind: 'text', question: 'URL' }, [ESC])).got).toEqual([null]);
    const q: SetupQuestion = { kind: 'select', question: 'Which?', options: opts('a'), default: 0 };
    expect((await answer(q, [ESC])).got).toEqual([null]);
  });

  test('a written config is in use without a restart', () => {
    expect(setupEnded({ outcome: 'written', file: '/home/me/.switchback/config.json' })).toContain(
      "it's in use now",
    );
  });
});

describe('after setup writes a config', () => {
  // afterSetup reads and writes the user config; keep it away from the real one.
  let home: string;
  const was = process.env.SWITCHBACK_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'switchback-setup-panel-'));
    process.env.SWITCHBACK_HOME = home;
  });
  afterEach(() => {
    if (was === undefined) delete process.env.SWITCHBACK_HOME;
    else process.env.SWITCHBACK_HOME = was;
    rmSync(home, { recursive: true, force: true });
  });

  /** A client whose setup writes a config straight away. */
  const writes = {
    on: (l: (e: EngineEvent) => void) => {
      setTimeout(() =>
        l({ type: 'setup.finished', setupId: 's', outcome: 'written', file: '/c.json' }),
      );
      return () => {};
    },
    request: async () => ({ setupId: 's' }),
  } as unknown as SwitchbackClient;

  function Opened({ said }: { said: string[] }) {
    const setup = useSetup(writes, (text) => said.push(text));
    // biome-ignore lint/correctness/useExhaustiveDependencies: once, as the TUI opens on setup
    useEffect(() => setup.start(), []);
    return <Box>{setup.panel}</Box>;
  }

  test('the panel asks the telemetry question, and Esc leaves it unchosen', async () => {
    const said: string[] = [];
    const ui = render(<Opened said={said} />);
    // Windows first offers the command sandbox; Esc skips it.
    if (process.platform === 'win32') {
      await frameWith(ui, 'command sandbox');
      ui.stdin.write(ESC);
    }
    expect(await frameWith(ui, 'anonymous')).toContain('Set up ·');
    ui.stdin.write(ESC);
    expect(await frameWithout(ui, 'Set up ·')).not.toContain('Set up ·');
    await until(() => said.length > 0);
    expect(said).toEqual([setupEnded({ outcome: 'written', file: '/c.json' })]);
    ui.unmount();
  }, 20_000);
});
