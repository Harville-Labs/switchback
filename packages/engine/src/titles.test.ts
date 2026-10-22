import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchbackClient } from '@switchback/client';
import {
  createTransportPair,
  type EngineEvent,
  type Message,
  SESSION_TITLE_MAX,
} from '@switchback/protocol';
import { type Provider, ScriptedProvider } from '@switchback/providers';
import { latestMarker, SUMMARIZER_PROMPT, splitTitle } from './compaction.ts';
import { SwitchbackConfig } from './config.ts';
import { Engine } from './engine.ts';
import { serve } from './server.ts';
import { FileSessionStore } from './store.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'switchback-titles-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** An engine whose local summarizer ends each summary with `title`. */
function engine(title = 'Parser refactor') {
  const local = new ScriptedProvider('lp', 'local', (req) =>
    req.system === SUMMARIZER_PROMPT
      ? { text: `- the user wants the parser refactored\n\nTitle: ${title}` }
      : { text: `ok ${'z'.repeat(600)}` },
  );
  const remote = new ScriptedProvider('rp', 'remote', () => ({ text: 'remote' }));
  const e = new Engine({
    workspaceRoot: root,
    config: SwitchbackConfig.parse({
      providers: { lp: { type: 'mock', tier: 'local' }, rp: { type: 'mock', tier: 'remote' } },
      models: {
        local: { provider: 'lp', model: 'small', contextWindow: 1_000_000 },
        remote: { provider: 'rp', model: 'big', contextWindow: 1_000_000 },
      },
      routing: { current: ['local'], escalate: [['remote']] },
    }),
    providers: new Map<string, Provider>([
      ['lp', local],
      ['rp', remote],
    ]),
    store: new FileSessionStore(join(root, 'sessions')),
  });
  const events: EngineEvent[] = [];
  e.subscribe((ev) => events.push(ev));
  return { e, remote, events };
}

const renames = (events: EngineEvent[]) =>
  events.flatMap((ev) => (ev.type === 'session.renamed' ? [[ev.title, ev.source]] : []));

describe('splitTitle', () => {
  test('takes the last Title line off the summary', () => {
    expect(splitTitle('- did things\n\nTitle: Fix the parser')).toEqual({
      summary: '- did things',
      title: 'Fix the parser',
    });
  });

  test('tolerates Markdown around the label and the title', () => {
    expect(splitTitle('notes\n**Title:** "Fix the parser".\n')).toEqual({
      summary: 'notes',
      title: 'Fix the parser',
    });
  });

  test('a summary without a title line is left alone', () => {
    expect(splitTitle('- did things\n- Title: is mid-list')).toEqual({
      summary: '- did things\n- Title: is mid-list',
    });
  });
});

describe('session titles', () => {
  test('session.rename round-trips: the event, the list, and the limit', async () => {
    const { e } = engine();
    const [serverSide, clientSide] = createTransportPair();
    serve(e, serverSide);
    const client = new SwitchbackClient(clientSide);
    await client.initialize({ name: 'test', version: '0' }, root);
    const seen: EngineEvent[] = [];
    client.on((ev) => seen.push(ev));

    const s = await client.request('session.create', {});
    const renamed = await client.request('session.rename', {
      sessionId: s.id,
      title: '  Parser work  ',
    });
    expect(renamed.title).toBe('Parser work');
    expect(renames(seen)).toEqual([['Parser work', 'user']]);
    expect((await client.request('session.get', { sessionId: s.id })).session.title).toBe(
      'Parser work',
    );

    await expect(client.request('session.rename', { sessionId: s.id, title: ' ' })).rejects.toThrow(
      "title: can't be empty",
    );
    await expect(
      client.request('session.rename', { sessionId: s.id, title: 'x'.repeat(61) }),
    ).rejects.toThrow(`title: is 61 characters; the limit is ${SESSION_TITLE_MAX}`);
  });

  test('the first prompt names the session, one line within the limit', async () => {
    const { e, events } = engine();
    const s = e.createSession({});
    await e.runTurn(s.id, `refactor\n  the parser ${'so that it is faster '.repeat(5)}`);
    const title = e.getSession(s.id).session.title;
    expect(title).toStartWith('refactor the parser so that');
    expect(title).toHaveLength(SESSION_TITLE_MAX);
    expect(renames(events)).toEqual([[title, 'prompt']]);
  });

  test("a title set before the first prompt isn't replaced by it, and survives a restart", async () => {
    const first = engine().e;
    const s = first.createSession({});
    first.renameSession(s.id, 'Parser work');
    await first.runTurn(s.id, 'refactor the parser');
    first.renameSession(s.id, 'Parser work, part two');

    const second = engine().e;
    expect(second.listSessions().map((x) => x.title)).toEqual(['Parser work, part two']);
    expect(second.getSession(s.id).session.title).toBe('Parser work, part two');
  });

  test('compaction retitles the session from the summary, locally, without a title line in it', async () => {
    const { e, remote, events } = engine();
    const s = e.createSession({});
    for (let i = 0; i < 6; i++) await e.runTurn(s.id, `step ${i}`);
    expect(await e.compactSession(s.id)).toEqual({ compacted: true });

    expect(e.getSession(s.id).session.title).toBe('Parser refactor');
    expect(renames(events).at(-1)).toEqual(['Parser refactor', 'compaction']);
    expect(remote.requests).toHaveLength(0);
    const marker = latestMarker(e.getSession(s.id).messages as Message[]);
    // The model's summary, then the record kept word for word from the transcript.
    expect(marker?.part.summary).toStartWith('- the user wants the parser refactored\n\n## Record');
    expect(marker?.part.summary).toContain('- step 0');
    // The transcript wasn't rewritten: the first prompt is still the first message.
    expect(e.getSession(s.id).messages[0]).toMatchObject({ parts: [{ text: 'step 0' }] });
  });

  test('compaction never replaces a title the user chose, even after a restart', async () => {
    const first = engine().e;
    const s = first.createSession({});
    for (let i = 0; i < 6; i++) await first.runTurn(s.id, `step ${i}`);
    first.renameSession(s.id, 'My name for it');

    const { e, events } = engine();
    expect(await e.compactSession(s.id)).toEqual({ compacted: true });
    expect(e.getSession(s.id).session.title).toBe('My name for it');
    expect(renames(events)).toEqual([]);
  });
});
