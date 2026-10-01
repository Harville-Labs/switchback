import * as assert from 'node:assert';
import { join } from 'node:path';
import type { EngineEvent } from '@switchback/protocol';
import * as vscode from 'vscode';
import { api, waitFor } from './helpers.ts';

suite('Editor context', () => {
  test('the selection is attached to the prompt with its line range', async () => {
    const a = await api();
    await vscode.commands.executeCommand('switchback.newSession');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const doc = await vscode.workspace.openTextDocument(join(root, 'hello.ts'));
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(1, 0, 1, 30); // line 2

    const events: EngineEvent[] = [];
    const sub = a.onEvent((e) => events.push(e));
    await a.prompt('what does this line do?', { selection: true });
    await waitFor(() => events.some((e) => e.type === 'turn.completed'), 20_000, 'turn');
    sub.dispose();

    const user = (await a.transcript()).find((m) => m.role === 'user');
    const attached = user?.parts.find((p) => p.type === 'text' && p.attachment);
    assert.ok(attached && attached.type === 'text');
    assert.deepStrictEqual(attached.attachment, { path: 'hello.ts:2-2' });
    assert.match(attached.text, /return `hello \$\{name\}`;/);
  });
});
