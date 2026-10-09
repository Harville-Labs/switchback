import { SWITCHBACK_BRANCH } from '@switchback/protocol';
import { z } from 'zod';
import { gitToplevel } from '../worktree.ts';
import { mergeBlocker, mergeWorktree, worktreeDiff } from '../worktree-info.ts';
import { defineTool, type ToolContext, ToolError } from './tool.ts';

/** Prompts show this much of the diff; the whole change still merges. */
const PREVIEW_LINES = 400;

async function repoOf(ctx: ToolContext): Promise<string> {
  const repo = await gitToplevel(ctx.workspaceRoot);
  if (!repo) throw new ToolError('this workspace is not a git repository');
  return repo;
}

/**
 * Lands an isolated subagent's branch in the user's working tree. The
 * permission gate always asks for it, showing the diff (permissions/gate.ts).
 */
export const mergeWorktreeTool = defineTool({
  name: 'merge_worktree',
  description:
    "Merge a branch an isolated subagent left (switchback/...) into the user's checked-out branch, as its own merge commit. The user is always asked first and sees the diff. Refused while the working tree has uncommitted changes; a conflict aborts the merge and names the files.",
  schema: z.object({
    branch: z
      .string()
      .regex(SWITCHBACK_BRANCH)
      .describe("The branch named in the subagent's report, such as switchback/1a2b3c4d5e6f"),
  }),
  permission: 'edit',
  mutating: true,
  summarize: (i) => `merge ${i.branch}`,
  async preview(input, ctx) {
    const repo = await repoOf(ctx);
    const { diff } = await worktreeDiff(repo, input.branch).catch(() => {
      throw new ToolError(`there's no branch ${input.branch} in this repository`);
    });
    // A merge that would be refused isn't worth asking about.
    const blocked = await mergeBlocker(repo, input.branch);
    if (blocked) throw new ToolError(blocked);
    const lines = diff.split('\n');
    return {
      diff:
        lines.length <= PREVIEW_LINES
          ? diff
          : `${lines.slice(0, PREVIEW_LINES).join('\n')}\n… ${lines.length - PREVIEW_LINES} more diff lines`,
    };
  },
  async run(input, ctx) {
    const repo = await repoOf(ctx);
    return mergeWorktree(repo, input.branch).catch((err: Error) => {
      throw new ToolError(err.message);
    });
  },
});
