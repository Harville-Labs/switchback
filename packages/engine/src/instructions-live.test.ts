import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineEvent, Message } from '@switchback/protocol';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { contextOf } from './compaction.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { instructionReminders, WatchedInstructions } from './instructions-live.ts';
import { FileSessionStore } from './store.ts';

let base: string;
let root: string;
let home: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'switchback-live-'));
  root = join(base, 'repo');
  home = join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  writeFileSync(join(root, 'AGENTS.md'), 'Use tabs.\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const files = () => ({ user: join(home, 'AGENTS.md'), project: join(root, 'AGENTS.md') });

function engine(store = new FileSessionStore(join(base, 'sessions'))) {
  const lp = new ScriptedProvider('lp', 'local', () => ({ text: 'ok' }));
  const e = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' } },
      models: { m: { provider: 'lp', model: 'small', contextWindow: 32_000 } },
      routing: { start: ['m'] },
    }),
    providers: new Map<string, Provider>([['lp', lp]]),
    instructionsSource: new WatchedInstructions(files(), 20),
    store,
  });
  return { e, lp, store };
}

/** The reminder parts in a request's last message. */
const reminders = (m: Message | undefined) =>
  (m?.parts ?? []).filter((p) => p.type === 'text' && p.instructions);

describe('an AGENTS.md change reaches running sessions', () => {
  test('both sessions get it with their next prompt, once, and nothing earlier changes', async () => {
    const { e, lp } = engine();
    const a = e.createSession({}).id;
    const b = e.createSession({}).id;
    await e.runTurn(a, 'one');
    await e.runTurn(b, 'one');
    const before = JSON.parse(JSON.stringify(lp.requests[0])) as (typeof lp.requests)[number];

    writeFileSync(join(root, 'AGENTS.md'), 'Use spaces.\n');
    await e.runTurn(a, 'two');
    await e.runTurn(b, 'two');
    await e.runTurn(a, 'three');

    const [a2, b2, a3] = lp.requests.slice(2);
    for (const r of [a2, b2]) {
      const parts = reminders(r?.messages.at(-1));
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ reminder: true, instructions: { scope: 'project' } });
      expect(parts[0]?.type === 'text' && parts[0].text).toContain(
        'These instructions replace the "Project instructions" section of your system prompt:\n\nUse spaces.',
      );
      // The cached prefix stays put: same system prompt, same earlier messages.
      expect(r?.system).toBe(before?.system as string);
      expect(r?.system).toContain('Use tabs.');
    }
    expect(a2?.messages[0]).toEqual(before.messages[0] as Message);
    expect(reminders(a3?.messages.at(-1))).toHaveLength(0);
  });

  test('a new session starts with the new text and no reminder', async () => {
    const { e, lp } = engine();
    writeFileSync(join(home, 'AGENTS.md'), 'Answer briefly.\n');
    await e.runTurn(e.createSession({}).id, 'hi');
    expect(lp.requests[0]?.system).toContain(
      '# User instructions (every project)\nAnswer briefly.',
    );
    expect(reminders(lp.requests[0]?.messages.at(-1))).toHaveLength(0);
  });

  test('a deleted AGENTS.md tells the model to disregard it', async () => {
    const { e, lp } = engine();
    const s = e.createSession({}).id;
    await e.runTurn(s, 'one');
    rmSync(join(root, 'AGENTS.md'));
    await e.runTurn(s, 'two');
    const [part] = reminders(lp.requests[1]?.messages.at(-1));
    expect(part).toMatchObject({ instructions: { scope: 'project' } });
    expect(part?.type === 'text' && part.text).toContain(
      'was removed. Disregard the "Project instructions"',
    );
  });

  test('a resumed session in another engine knows what it was already told', async () => {
    const first = engine();
    const s = first.e.createSession({}).id;
    await first.e.runTurn(s, 'one');
    writeFileSync(join(root, 'AGENTS.md'), 'Use spaces.\n');
    await first.e.runTurn(s, 'two');
    await first.e.shutdown();

    const second = engine(first.store);
    second.e.getSession(s);
    await second.e.runTurn(s, 'three');
    expect(reminders(second.lp.requests[0]?.messages.at(-1))).toHaveLength(0);
    writeFileSync(join(root, 'AGENTS.md'), 'Use either.\n');
    await second.e.runTurn(s, 'four');
    expect(reminders(second.lp.requests[1]?.messages.at(-1))).toHaveLength(1);
  });

  test('every engine on the machine sees one edit, and clients hear about it', async () => {
    const one = engine();
    const two = engine();
    const notes: string[] = [];
    one.e.subscribe((ev: EngineEvent) => {
      if (ev.type === 'config.updated') notes.push(...ev.notes);
    });
    const a = one.e.createSession({}).id;
    const b = two.e.createSession({}).id;
    writeFileSync(join(root, 'AGENTS.md'), 'Use spaces.\n');
    for (let i = 0; i < 50 && !notes.length; i++) await Bun.sleep(20);
    expect(notes).toEqual([
      "The project's AGENTS.md changed; sessions get it with their next message",
    ]);
    await one.e.runTurn(a, 'go');
    await two.e.runTurn(b, 'go');
    expect(reminders(one.lp.requests[0]?.messages.at(-1))).toHaveLength(1);
    expect(reminders(two.lp.requests[0]?.messages.at(-1))).toHaveLength(1);
    await one.e.shutdown();
    await two.e.shutdown();
  });
});

test('compaction carries the latest instructions past its summary', () => {
  const [changed] = instructionReminders({ project: 'old' }, { project: 'Use spaces.' });
  const messages: Message[] = [
    { role: 'user', parts: [{ type: 'text', text: 'one' }, changed as never] },
    { role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
    { role: 'user', parts: [{ type: 'text', text: 'two' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'b' }] },
    {
      role: 'user',
      parts: [{ type: 'compaction', summary: 'S', keepFrom: 3, tokensBefore: 9, tokensAfter: 3 }],
    },
  ];
  const [summary] = contextOf(messages);
  expect(summary?.parts.map((p) => p.type === 'text' && p.text.slice(0, 22))).toEqual([
    '<conversation_summary>',
    "The project's AGENTS.m",
  ]);
});
