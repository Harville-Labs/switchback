import { expect, test } from 'bun:test';
import type { EngineEvent } from '@switchback/protocol';
import { formatSetupNote, runSetupOver } from './setup.ts';

test('a setup run answers each question, shows notes, and ends with the outcome', async () => {
  const listeners = new Set<(e: EngineEvent) => void>();
  const emit = (e: EngineEvent) => {
    for (const l of listeners) l(e);
  };
  const answers: unknown[] = [];
  let started: unknown;
  const client = {
    on: (l: (e: EngineEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    request: async (method: string, params: { value?: unknown }) => {
      if (method === 'setup.start') {
        started = params;
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
  const said: string[] = [];
  const outcome = await runSetupOver(
    client as never,
    {
      ask: async (q) => q.kind === 'confirm',
      note: (n) => said.push(formatSetupNote(n)),
    },
    { scope: 'project' },
  );
  expect(started).toEqual({ scope: 'project' });
  expect(said).toEqual(['Looking...']);
  expect(answers).toEqual([true]);
  expect(outcome).toEqual({ outcome: 'written', file: '/c.json' });
});
