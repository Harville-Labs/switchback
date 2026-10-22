/**
 * Goals (`/goal`, ADR 0024): after each turn of a top-level session working
 * toward a goal, decide whether another turn starts. The model ends a goal
 * with the `goal` tool; limits and failing turns end it too. The goal lives in
 * memory only: a resumed session never starts spending on its own.
 */
import type { GoalInfo, StopReason } from '@switchback/protocol';
import { type EngineHost, type LiveSession, scope } from './live-session.ts';

/** Failed turns in a row (errors, refusals) that stop a goal. */
export const MAX_ERROR_STREAK = 3;

/** Longest objective a continuation repeats in full. */
export const EXCERPT_CHARS = 200;

/**
 * The objective as each continuation names it. The full text is already in
 * the transcript (the first prompt), so repeating up to 4000 characters on
 * every turn would only fill the context window.
 */
export function goalExcerpt(objective: string): string {
  if (objective.length <= EXCERPT_CHARS) return objective;
  return `${objective.slice(0, EXCERPT_CHARS).trimEnd()}… (in full in your first prompt)`;
}

export interface GoalState {
  info: GoalInfo;
  startedMs: number;
  limitMs: number;
  /** Failed turns in a row. */
  errors: number;
  /** The model has been told about the goal (the first prompt carries it). */
  told: boolean;
}

export type GoalStep =
  | { kind: 'continue' }
  /** No turn starts now, but the goal stays active (an interrupting prompt took over). */
  | { kind: 'wait' }
  | { kind: 'stop'; note: string };

/** What follows a finished turn of an active goal, and the failure streak after it. */
export function nextGoalStep(
  goal: Pick<GoalState, 'startedMs' | 'limitMs' | 'errors'> & { turns: number; maxTurns: number },
  stopReason: StopReason,
  nowMs: number,
): { step: GoalStep; errors: number } {
  if (stopReason === 'cancelled') return { step: { kind: 'wait' }, errors: goal.errors };
  const failed = stopReason === 'error' || stopReason === 'refusal';
  const errors = failed ? goal.errors + 1 : 0;
  if (errors >= MAX_ERROR_STREAK)
    return { step: { kind: 'stop', note: `${errors} turns in a row failed` }, errors };
  if (goal.turns >= goal.maxTurns)
    return { step: { kind: 'stop', note: `reached the limit of ${goal.maxTurns} turns` }, errors };
  if (nowMs - goal.startedMs >= goal.limitMs) {
    const minutes = goal.limitMs / 60_000;
    const note = `reached the limit of ${minutes} minute${minutes === 1 ? '' : 's'}`;
    return { step: { kind: 'stop', note }, errors };
  }
  return { step: { kind: 'continue' }, errors };
}

export class Goals {
  constructor(
    private readonly host: EngineHost,
    private readonly now: () => number = Date.now,
  ) {}

  /** Start a new goal, replacing any other; its first turn is the caller's to start. */
  set(s: LiveSession, objective: string): GoalInfo {
    const limits = this.host.config().goal;
    const startedMs = this.now();
    s.goal = {
      info: {
        objective,
        status: 'active',
        turns: 1,
        maxTurns: limits.maxTurns,
        startedAt: new Date(startedMs).toISOString(),
      },
      startedMs,
      limitMs: limits.maxMinutes * 60_000,
      errors: 0,
      told: false,
    };
    this.emit(s);
    return s.goal.info;
  }

  /** Stop the active goal, if there is one; the running turn carries on. */
  stop(s: LiveSession, note: string): GoalInfo | undefined {
    if (s.goal?.info.status !== 'active') return undefined;
    return this.end(s, 'stopped', note);
  }

  /** The `goal` tool: the model says the goal is met, or that it needs the user. */
  report(s: LiveSession, status: 'done' | 'blocked', summary: string): GoalInfo | undefined {
    if (s.goal?.info.status !== 'active') return undefined;
    return this.end(s, status, summary);
  }

  /** What the next prompt tells the model about a goal it hasn't heard of yet. */
  note(s: LiveSession): string | undefined {
    const goal = s.goal;
    if (!goal || goal.told || goal.info.status !== 'active') return undefined;
    goal.told = true;
    return `You are working toward a goal over several turns: ${goal.info.objective}\nWhen you finish a turn and the goal isn't met, you will be asked to continue, for at most ${goal.info.maxTurns} turns. When the goal is met, call the \`goal\` tool with status "done" and a short summary. If you can't go on without the user (a decision, access, missing information), call it with status "blocked" and say what you need. Ending a turn without calling it means you are still working.`;
  }

  /**
   * A top-level turn ended. Returns the reminder that starts the next turn
   * when the goal continues; otherwise nothing (and the goal may have ended).
   */
  afterTurn(s: LiveSession, stopReason: StopReason): string | undefined {
    const goal = s.goal;
    if (goal?.info.status !== 'active') return undefined;
    const { step, errors } = nextGoalStep(
      { ...goal, turns: goal.info.turns, maxTurns: goal.info.maxTurns },
      stopReason,
      this.now(),
    );
    goal.errors = errors;
    if (step.kind === 'wait') return undefined;
    if (step.kind === 'stop') {
      this.end(s, 'stopped', step.note);
      return undefined;
    }
    goal.info = { ...goal.info, turns: goal.info.turns + 1 };
    this.emit(s);
    const failed = errors ? ' The last turn failed; try another way.' : '';
    return `Keep working toward the goal: ${goalExcerpt(goal.info.objective)}\nThis is turn ${goal.info.turns} of at most ${goal.info.maxTurns}.${failed} Call the \`goal\` tool with status "done" when it is met, or "blocked" if you need the user.`;
  }

  private end(s: LiveSession, status: 'done' | 'blocked' | 'stopped', note: string): GoalInfo {
    const goal = s.goal as GoalState;
    goal.info = { ...goal.info, status, note };
    this.emit(s);
    return goal.info;
  }

  private emit(s: LiveSession): void {
    if (s.goal) this.host.emit({ type: 'goal.updated', ...scope(s), goal: s.goal.info });
  }
}
