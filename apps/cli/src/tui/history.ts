/** Prompt history, per workspace, persisted under the harness data directory. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { harnessPaths } from '@harness/engine';

const MAX = 1000;

export class PromptHistory {
  private entries: string[] = [];
  private readonly file: string;

  constructor(
    private readonly workspace: string,
    file = join(harnessPaths().dataDir, 'prompt-history.jsonl'),
  ) {
    this.file = file;
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { cwd: string; text: string };
        if (e.cwd === workspace) this.entries.push(e.text);
      } catch {
        // skip a torn line
      }
    }
    // Keep the file bounded across all workspaces.
    if (lines.length > MAX * 2) writeFileSync(file, `${lines.slice(-MAX).join('\n')}\n`);
  }

  /** Oldest first. */
  list(): readonly string[] {
    return this.entries;
  }

  add(text: string): void {
    if (!text.trim() || this.entries.at(-1) === text) return;
    this.entries.push(text);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify({ cwd: this.workspace, text })}\n`);
    } catch {
      // History is a convenience; never fail a prompt over it.
    }
  }
}
