/**
 * How both clients describe isolated subagents' worktrees: the line on a
 * subagent's row, `/worktrees`, and one branch's diff.
 */
import type { WorktreeDiff, WorktreeInfo, WorktreeOutcome } from '@switchback/protocol';

/** `+40 −2` and file count, as git counts them. */
function size(w: { files: number; insertions: number; deletions: number }): string {
  return `${w.files} file${w.files === 1 ? '' : 's'} +${w.insertions} −${w.deletions}`;
}

/** The worktree line on a subagent's row: its branch while it runs, then what it left. */
export function worktreeLabel(w: { branch: string } & Partial<WorktreeOutcome>): string {
  if (w.kept) return `⎇ ${w.branch} · kept at ${w.kept}`;
  if (w.changed === undefined) return `⎇ ${w.branch}`;
  if (!w.changed) return '⎇ no changes';
  return `⎇ ${w.branch} · ${size({ files: w.files ?? 0, insertions: w.insertions ?? 0, deletions: w.deletions ?? 0 })}`;
}

const STATE: Record<WorktreeInfo['state'], string> = {
  running: 'running',
  ready: 'ready to merge',
  merged: 'merged',
  kept: 'kept after a failure',
};

/**
 * `/worktrees` and `switchback worktrees`: every branch, newest first.
 * `show` is how to see one branch's diff where the list is printed.
 */
export function formatWorktrees(list: WorktreeInfo[], show = '/worktrees <branch>'): string {
  if (!list.length)
    return 'No worktrees. Subagents get their own with `isolation: worktree` (docs/subagents.md#worktree-isolation).';
  const lines = list.flatMap((w) => {
    const ahead = w.ahead ? ` · ${w.ahead} commit${w.ahead === 1 ? '' : 's'} ahead` : '';
    const what = w.task ? `${w.task}${w.agent ? ` (${w.agent})` : ''}` : undefined;
    // A merged branch has nothing left to show the size of.
    const detail = w.state === 'merged' ? '' : ` · ${size(w)}${ahead}`;
    return [
      `⎇ ${w.branch}  ${STATE[w.state]}${detail}`,
      ...(what ? [`    ${what}`] : []),
      ...(w.path ? [`    at ${w.path}`] : []),
    ];
  });
  return [
    ...lines,
    '',
    `See one: ${show}. Ask the agent to merge one; it asks you first, with the diff.`,
  ].join('\n');
}

/** One branch's changes as text: its stat, then the diff. */
export function formatWorktreeDiff(d: WorktreeDiff): string {
  if (!d.diff) return `${d.branch} has no changes from ${d.base.slice(0, 8)}.`;
  return `${d.branch} since ${d.base.slice(0, 8)}\n${d.stat}\n\n${d.diff}`;
}
