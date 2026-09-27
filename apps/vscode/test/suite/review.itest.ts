import * as assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineEvent } from '@harness/protocol';
import * as vscode from 'vscode';
import { api, waitFor } from './helpers.ts';

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
const editPrompt = (from: string, to: string) =>
  `mock:tool ${JSON.stringify({ name: 'edit', input: { path: 'hello.ts', oldString: from, newString: to } })}`;

suite('Edit review in the diff editor', () => {
  let original: string;
  suiteSetup(() => {
    original = readFileSync(join(root(), 'hello.ts'), 'utf8');
  });
  teardown(() => writeFileSync(join(root(), 'hello.ts'), original));

  const run = async (
    from: string,
    to: string,
    answer: 'harness.acceptEdit' | 'harness.rejectEdit',
  ) => {
    const a = await api();
    await vscode.commands.executeCommand('harness.newSession');
    const events: EngineEvent[] = [];
    const sub = a.onEvent((e) => events.push(e));
    await a.prompt(editPrompt(from, to));
    await waitFor(() => a.pendingReviews().length === 1, 20_000, 'diff editor');
    const activeDiff = () => {
      const t = vscode.window.tabGroups.activeTabGroup.activeTab;
      return t?.input instanceof vscode.TabInputTextDiff ? t : undefined;
    };
    await waitFor(() => !!activeDiff(), 10_000, 'active diff tab');
    const tab = activeDiff();
    assert.ok(tab, 'a diff tab is active');
    assert.match(tab.label, /hello\.ts \(proposed by Harness\)/);
    await vscode.commands.executeCommand(answer);
    await waitFor(() => events.some((e) => e.type === 'turn.completed'), 20_000, 'turn');
    sub.dispose();
    await waitFor(() => a.pendingReviews().length === 0, 5_000, 'review closed');
    const stillOpen = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some(
        (t) =>
          t.input instanceof vscode.TabInputTextDiff &&
          t.input.modified.scheme === 'harness-proposed',
      );
    assert.strictEqual(stillOpen, false, 'diff tab closed');
    return events;
  };

  test('accept applies the edit', async () => {
    await run('hello ${name}', 'hi ${name}', 'harness.acceptEdit');
    assert.match(readFileSync(join(root(), 'hello.ts'), 'utf8'), /hi \$\{name\}/);
  });

  test('reject leaves the file alone and tells the model', async () => {
    const events = await run('hello ${name}', 'bye ${name}', 'harness.rejectEdit');
    assert.strictEqual(readFileSync(join(root(), 'hello.ts'), 'utf8'), original);
    assert.ok(events.some((e) => e.type === 'tool.completed' && e.isError));
  });
});
