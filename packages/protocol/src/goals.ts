/**
 * Goals (`/goal`, ADR 0024): an objective the engine keeps a top-level
 * session working toward, one turn after another, until the model reports it
 * done or blocked, a limit stops it, or the user does.
 */
import { z } from 'zod';

/**
 * `active` while turns keep starting; `done` and `blocked` when the model said
 * so (the `goal` tool); `stopped` when the user, an interrupt, a limit, or
 * failing turns ended it (`note` says which).
 */
export type GoalStatus = 'active' | 'done' | 'blocked' | 'stopped';

export interface GoalInfo {
  objective: string;
  status: GoalStatus;
  /** Turns finished while the goal was active, the first one included. */
  turns: number;
  maxTurns: number;
  startedAt: string;
  /** The model's summary (done, blocked), or why the goal stopped. */
  note?: string;
}

/** A string sets a new goal and starts working on it; `null` stops the current one. */
export const SessionSetGoalParams = z.object({
  sessionId: z.string(),
  objective: z.string().trim().min(1).max(4000).nullable(),
});
export type SessionSetGoalParams = z.infer<typeof SessionSetGoalParams>;

export interface SessionSetGoalResult {
  goal?: GoalInfo;
  /** The turn the objective started, or the running turn it was queued for. */
  turnId?: string;
}
