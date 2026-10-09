/** `switchback worktrees [branch]`: branches isolated subagents made here, or one branch's diff. */
import { formatWorktreeDiff, formatWorktrees } from '@switchback/client';
import { type CommonFlags, createEngine } from '../bootstrap.ts';

export async function worktrees(
  flags: CommonFlags & { json: boolean; branch?: string },
): Promise<number> {
  const { engine } = createEngine(flags, 'deny');
  try {
    const result = flags.branch
      ? await engine.worktreeDiff(flags.branch)
      : await engine.listWorktrees();
    const text = flags.json
      ? JSON.stringify(result, null, 2)
      : 'diff' in result
        ? formatWorktreeDiff(result)
        : formatWorktrees(result, 'switchback worktrees <branch>');
    process.stdout.write(`${text}\n`);
    return 0;
  } finally {
    await engine.shutdown();
  }
}
