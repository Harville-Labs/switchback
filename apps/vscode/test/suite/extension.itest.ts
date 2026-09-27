import * as assert from 'node:assert';
import type { EngineEvent } from '@harness/protocol';
import * as vscode from 'vscode';
import { api, waitFor } from './helpers.ts';

suite('Harness extension', () => {
  test('activates and connects to the engine over stdio', async () => {
    const a = await api();
    assert.ok(a.init()?.agents.some((x) => x.name === 'explore'));
  });

  test('runs a prompt end to end', async () => {
    const a = await api();
    const events: EngineEvent[] = [];
    const sub = a.onEvent((e) => events.push(e));
    await a.prompt('hello from vscode');
    await waitFor(() => events.some((e) => e.type === 'turn.completed'), 20_000, 'turn');
    sub.dispose();
    const text = events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
    assert.strictEqual(text, '[mock mock-local] You said: hello from vscode');
  });

  test('registers its commands', async () => {
    await api();
    const all = await vscode.commands.getCommands(true);
    for (const c of [
      'harness.newSession',
      'harness.setRoute',
      'harness.askAboutSelection',
      'harness.runSetup',
    ])
      assert.ok(all.includes(c), c);
  });
});
