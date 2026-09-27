/**
 * Review proposed edits in VS Code's diff editor. The proposed file is a
 * virtual `harness-proposed:` document; Accept / Reject buttons in the editor
 * title answer the pending permission request. The tab closes when the
 * request resolves, wherever it was answered.
 */
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';

export const PROPOSED_SCHEME = 'harness-proposed';

export class EditReview implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly open = new Map<string, vscode.Uri>(); // requestId -> proposed uri
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changes.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** The pending request a proposed document belongs to. */
  requestIdOf(uri: vscode.Uri | undefined): string | undefined {
    if (uri?.scheme !== PROPOSED_SCHEME) return undefined;
    return new URLSearchParams(uri.query).get('request') ?? undefined;
  }

  async show(root: string, requestId: string, proposed: { path: string; content: string }) {
    const original = vscode.Uri.joinPath(vscode.Uri.file(root), proposed.path);
    const right = vscode.Uri.from({
      scheme: PROPOSED_SCHEME,
      path: `/${proposed.path}`,
      query: `request=${requestId}`,
    });
    this.contents.set(right.toString(), proposed.content);
    let left = original;
    if (!existsSync(original.fsPath)) {
      // New file: diff against an empty document.
      left = right.with({ query: `request=${requestId}&side=empty` });
      this.contents.set(left.toString(), '');
    }
    this.open.set(requestId, right);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${proposed.path} (proposed by Harness)`,
      { preview: false },
    );
  }

  async close(requestId: string) {
    if (!this.open.has(requestId)) return;
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      // Compare parsed request ids: VS Code re-encodes URI queries.
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputTextDiff &&
          this.requestIdOf(t.input.modified) === requestId,
      );
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
    // Only now is the review gone from the user's point of view.
    this.open.delete(requestId);
    for (const key of [...this.contents.keys()])
      if (this.requestIdOf(vscode.Uri.parse(key)) === requestId) this.contents.delete(key);
  }

  pending(): string[] {
    return [...this.open.keys()];
  }

  dispose() {
    this.changes.dispose();
  }
}
