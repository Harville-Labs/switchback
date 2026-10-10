import { beforeEach, expect, mock, test } from 'bun:test';
import type { EngineEvent, SetupQuestion } from '@switchback/protocol';

/** Each quick pick or input box shown, and how the test answers it. */
type Shown = {
  kind: 'pick' | 'input';
  question: string;
  items?: string[];
  active?: string[];
  selected?: string[];
};
let shown: Shown[] = [];
/** The next answer: labels to accept, text to type, or undefined to dismiss. */
let reply: (s: Shown) => string[] | string | undefined;

mock.module('vscode', () => ({
  window: {
    createQuickPick: () => {
      const handlers: Record<string, ((v?: unknown) => void)[]> = {};
      const on = (name: string) => (fn: (v?: unknown) => void) => {
        handlers[name] = [...(handlers[name] ?? []), fn];
      };
      const fire = (name: string, v?: unknown) => {
        for (const fn of handlers[name] ?? []) fn(v);
      };
      const qp = {
        items: [] as { label: string }[],
        activeItems: [] as { label: string }[],
        selectedItems: [] as { label: string }[],
        canSelectMany: false,
        value: '',
        placeholder: '',
        onDidAccept: on('accept'),
        onDidHide: on('hide'),
        onDidChangeValue: on('value'),
        show() {
          const s: Shown = {
            kind: 'pick',
            question: qp.placeholder,
            items: qp.items.map((i) => i.label),
            active: qp.activeItems.map((i) => i.label),
            selected: qp.selectedItems.map((i) => i.label),
          };
          shown.push(s);
          const answer = reply(s);
          if (answer === undefined) return fire('hide');
          if (typeof answer === 'string') {
            qp.value = answer;
            fire('value', answer);
            qp.activeItems = qp.items.filter((i) => i.label === `Use "${answer}"`);
          } else {
            const chosen = qp.items.filter((i) => answer.includes(i.label));
            if (qp.canSelectMany) qp.selectedItems = chosen;
            else qp.activeItems = chosen;
          }
          fire('accept');
        },
        hide: () => fire('hide'),
        dispose() {},
      };
      return qp;
    },
    showInputBox: async (o: { prompt: string; value?: string }) => {
      const s: Shown = {
        kind: 'input',
        question: o.prompt,
        ...(o.value ? { active: [o.value] } : {}),
      };
      shown.push(s);
      const answer = reply(s);
      return typeof answer === 'string' ? answer : undefined;
    },
  },
}));

const { askSetupQuestion, runSetup } = await import('./setup-wizard.ts');

beforeEach(() => {
  shown = [];
});

const opts = (...labels: string[]) => labels.map((label) => ({ label }));

test('each kind of question becomes the right control, and answers map back', async () => {
  reply = () => ['No'];
  expect(await askSetupQuestion({ kind: 'confirm', question: 'Local?', default: true })).toBe(
    false,
  );
  // The default comes first.
  expect(shown[0]?.items).toEqual(['Yes', 'No']);

  reply = () => ['b'];
  const select: SetupQuestion = {
    kind: 'select',
    question: 'Which?',
    options: opts('a', 'b'),
    default: 1,
  };
  expect(await askSetupQuestion(select)).toBe(1);
  expect(shown.at(-1)?.active).toEqual(['b']);

  reply = () => ['a', 'c'];
  const multi: SetupQuestion = {
    kind: 'multiSelect',
    question: 'Models?',
    options: [{ label: 'a' }, { label: 'b', checked: true }, { label: 'c' }],
  };
  expect(await askSetupQuestion(multi)).toEqual([0, 2]);
  expect(shown.at(-1)?.selected).toEqual(['b']);

  reply = () => ['m2'];
  expect(
    await askSetupQuestion({
      kind: 'search',
      question: 'Model?',
      options: opts('m1', 'm2'),
      freeText: true,
    }),
  ).toBe(1);
  reply = () => 'my-finetune';
  expect(
    await askSetupQuestion({
      kind: 'search',
      question: 'Model?',
      options: opts('m1'),
      freeText: true,
    }),
  ).toBe('my-finetune');

  reply = () => '';
  expect(await askSetupQuestion({ kind: 'number', question: 'Budget?' })).toBe('');
  reply = () => '1,500';
  expect(await askSetupQuestion({ kind: 'number', question: 'Budget?' })).toBe(1500);
  reply = () => 'http://gpu:8000';
  expect(
    await askSetupQuestion({ kind: 'text', question: 'URL', default: 'http://localhost' }),
  ).toBe('http://gpu:8000');
});

test('dismissing any question answers null, which cancels setup', async () => {
  reply = () => undefined;
  expect(await askSetupQuestion({ kind: 'confirm', question: 'Local?', default: true })).toBeNull();
  expect(await askSetupQuestion({ kind: 'text', question: 'URL' })).toBeNull();
  expect(
    await askSetupQuestion({ kind: 'multiSelect', question: 'M?', options: opts('a') }),
  ).toBeNull();
});

test('a setup run answers each question, shows notes, and ends with the outcome', async () => {
  const listeners = new Set<(e: EngineEvent) => void>();
  const emit = (e: EngineEvent) => {
    for (const l of listeners) l(e);
  };
  const answers: unknown[] = [];
  const client = {
    on: (l: (e: EngineEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request: async (method: string, params: { value?: unknown }) => {
      if (method === 'setup.start') {
        // An event that beats the response must not be lost.
        emit({ type: 'setup.note', setupId: 'x', note: { kind: 'text', text: 'Looking...' } });
        emit({
          type: 'setup.ask',
          setupId: 'x',
          requestId: 'q1',
          question: { kind: 'confirm', question: 'Local?', default: false },
        });
        return { setupId: 'x' };
      }
      answers.push(params.value);
      setTimeout(() =>
        emit({ type: 'setup.finished', setupId: 'x', outcome: 'written', file: '/c.json' }),
      );
      return { ok: true };
    },
  };
  reply = () => ['Yes'];
  const said: string[] = [];
  const outcome = await runSetup(client as never, (t) => said.push(t));
  expect(said).toEqual(['Looking...']);
  expect(answers).toEqual([true]);
  expect(outcome).toEqual({ outcome: 'written', file: '/c.json' });
});
