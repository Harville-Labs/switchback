/**
 * Tracks what the user is looking at (active file, selection, diagnostics) so
 * the chat can offer it as context, and builds prompt attachments from it.
 */
import type { Attachment } from '@switchback/protocol';
import * as vscode from 'vscode';

export interface EditorContextState {
  /** Workspace-relative path of the active file, when it's in the workspace. */
  file?: string;
  selection?: { path: string; startLine: number; endLine: number };
  /** Errors and warnings in the active file. */
  problems: number;
}

export interface AttachChoice {
  file?: boolean;
  selection?: boolean;
  problems?: boolean;
}

const MAX_PROBLEMS = 50;

export class EditorContext implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onChange: (state: EditorContextState) => void) {
    const changed = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.onChange(this.state()), 150);
    };
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(changed),
      vscode.window.onDidChangeTextEditorSelection(changed),
      vscode.languages.onDidChangeDiagnostics(changed),
    );
  }

  /** The last text editor showing a workspace file (the chat itself isn't one). */
  private editor(): vscode.TextEditor | undefined {
    const e = vscode.window.activeTextEditor;
    return e && this.relative(e.document.uri) ? e : undefined;
  }

  private relative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false);
    return rel === uri.fsPath || rel.startsWith('..') ? undefined : rel.replaceAll('\\', '/');
  }

  state(): EditorContextState {
    const e = this.editor();
    if (!e) return { problems: 0 };
    const path = this.relative(e.document.uri) as string;
    const sel = e.selection;
    const problems = vscode.languages
      .getDiagnostics(e.document.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning).length;
    return {
      file: path,
      ...(sel.isEmpty
        ? {}
        : {
            selection: {
              path,
              startLine: sel.start.line + 1,
              // A selection ending at column 0 doesn't include that line.
              endLine:
                sel.end.character === 0 && sel.end.line > sel.start.line
                  ? sel.end.line
                  : sel.end.line + 1,
            },
          }),
      problems,
    };
  }

  attachments(choice: AttachChoice): Attachment[] {
    const s = this.state();
    const out: Attachment[] = [];
    if (choice.selection && s.selection) out.push({ kind: 'file', ...s.selection });
    else if (choice.file && s.file) out.push({ kind: 'file', path: s.file });
    if (choice.problems && s.file) {
      const e = this.editor();
      const diags = e
        ? vscode.languages
            .getDiagnostics(e.document.uri)
            .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
            .slice(0, MAX_PROBLEMS)
        : [];
      if (diags.length) {
        const sev = (d: vscode.Diagnostic) =>
          d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        out.push({
          kind: 'text',
          label: `Problems in ${s.file}`,
          text: diags
            .map(
              (d) =>
                `${s.file}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev(d)}: ${d.message}${d.source ? ` (${d.source})` : ''}`,
            )
            .join('\n'),
        });
      }
    }
    return out;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    for (const s of this.subs) s.dispose();
  }
}
