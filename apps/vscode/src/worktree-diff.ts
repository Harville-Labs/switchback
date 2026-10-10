/**
 * A subagent's branch in VS Code's multi-file diff editor. The engine sends
 * each changed file before and after (`worktrees.diff`); this serves them to
 * the editor, so the extension never runs git itself (clients are thin).
 */
import type { WorktreeDiff } from '@switchback/protocol';
import * as vscode from 'vscode';

export const WORKTREE_SCHEME = 'switchback-worktree';

export class WorktreeDiffs implements vscode.TextDocumentContentProvider {
  /** The branch shown last; a new one replaces it. */
  private contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Every changed file, side by side: where the branch started, and the branch. */
  async open(d: WorktreeDiff): Promise<void> {
    this.contents = new Map();
    const side = (path: string, which: 'base' | 'branch', text: string | undefined) => {
      const uri = vscode.Uri.from({
        scheme: WORKTREE_SCHEME,
        path: `/${path}`,
        query: `${d.branch}@${which}`,
      });
      this.contents.set(uri.toString(), text ?? '');
      return uri;
    };
    const resources = d.files.map((f) => {
      const after = side(f.path, 'branch', f.after);
      return [after, side(f.path, 'base', f.before), after] as const;
    });
    await vscode.commands.executeCommand('vscode.changes', `${d.branch} (subagent)`, resources);
  }
}

/** One per extension, registered at activation. */
export const worktreeDiffs = new WorktreeDiffs();
