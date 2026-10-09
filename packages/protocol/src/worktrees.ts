/**
 * Worktrees that isolated subagents work in (docs/subagents.md#worktree-isolation):
 * what clients show about them, and the methods that list and diff them.
 */
import { z } from 'zod';

/** Branches Switchback makes for isolated subagents; the only ones these methods take. */
export const SWITCHBACK_BRANCH = /^switchback\/[a-z0-9]{6,40}$/;

/** On `subagent.started`: where an isolated subagent works. */
export interface WorktreeStart {
  branch: string;
  path: string;
}

/** On `subagent.completed`: what an isolated subagent left on its branch. */
export interface WorktreeOutcome {
  branch: string;
  /** Whether it changed anything; a branch with no changes is deleted. */
  changed: boolean;
  files: number;
  insertions: number;
  deletions: number;
  /** Set when the worktree was kept for inspection (the subagent failed). */
  kept?: string;
}

export interface WorktreeInfo {
  branch: string;
  /**
   * `running`: its subagent is working. `ready`: finished, with commits your
   * branch doesn't have. `merged`: nothing left to merge. `kept`: its
   * subagent failed and the worktree was kept at `path`.
   */
  state: 'running' | 'ready' | 'merged' | 'kept';
  /** Commits on the branch that your checked-out branch doesn't have. */
  ahead: number;
  files: number;
  insertions: number;
  deletions: number;
  path?: string;
  /** Who made it and why, when Switchback recorded it. */
  agent?: string;
  task?: string;
  sessionId?: string;
  createdAt?: string;
}

export interface WorktreeDiff {
  branch: string;
  /** Where it left your branch (the merge base). */
  base: string;
  /** `git diff --stat`. */
  stat: string;
  /** Unified diff. */
  diff: string;
  /** Each changed file before and after, for side-by-side review; contents of very large files are left out. */
  files: {
    path: string;
    status: 'added' | 'modified' | 'deleted';
    before?: string;
    after?: string;
  }[];
}

export const WorktreesDiffParams = z.object({
  branch: z
    .string()
    .regex(
      SWITCHBACK_BRANCH,
      'a branch Switchback made for a subagent, such as switchback/1a2b3c4d5e6f',
    ),
});
export type WorktreesDiffParams = z.infer<typeof WorktreesDiffParams>;
