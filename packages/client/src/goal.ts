/** What both clients say about `/goal` (ADR 0024). */
import type { GoalInfo } from '@switchback/protocol';
import type { SwitchbackClient } from './client.ts';
import type { ViewState } from './view-state.ts';

export type GoalCommand = { kind: 'show' } | { kind: 'stop' } | { kind: 'set'; objective: string };

/** `/goal` arguments: none shows the goal, `stop` stops it, anything else is a new objective. */
export function parseGoalCommand(args: string[]): GoalCommand {
  const objective = args.join(' ').trim();
  if (!objective) return { kind: 'show' };
  if (objective === 'stop' || objective === 'clear') return { kind: 'stop' };
  return { kind: 'set', objective };
}

/**
 * The session's goal: from the view once an update arrived while it watched,
 * else from the session summary.
 */
export function sessionGoal(
  view: Pick<ViewState, 'goal'>,
  session: { goal?: GoalInfo },
): GoalInfo | undefined {
  return view.goal ?? session.goal;
}

/** One line for the pinned area while a goal is active. */
export function goalLine(goal: GoalInfo): string {
  return `◎ goal · turn ${goal.turns}/${goal.maxTurns} · ${goal.objective}`;
}

/** A goal starting or ending, for the transcript. */
export function goalNotice(goal: GoalInfo): string {
  const turns = `${goal.turns} turn${goal.turns === 1 ? '' : 's'}`;
  switch (goal.status) {
    case 'active':
      return `◎ working toward the goal, for up to ${goal.maxTurns} turns: ${goal.objective}\n  /goal shows progress; /goal stop or Esc ends it`;
    case 'done':
      return `◎ goal done after ${turns}${goal.note ? `: ${goal.note}` : ''}`;
    case 'blocked':
      return `◎ goal blocked after ${turns}, waiting for you${goal.note ? `: ${goal.note}` : ''}`;
    case 'stopped':
      return `◎ goal stopped after ${turns}${goal.note ? ` (${goal.note})` : ''}`;
  }
}

/** What bare `/goal` says. */
export function goalStatus(goal: GoalInfo | undefined): string {
  if (!goal) return 'no goal. /goal <objective> keeps the agent working until it is met';
  if (goal.status !== 'active') return `${goalNotice(goal)}\n  last goal: ${goal.objective}`;
  return `${goalLine(goal)}\n  /goal stop ends it after the running turn; Esc stops now`;
}

/**
 * Run `/goal` for either client. Returns the text to show, if any: a goal
 * starting or stopping shows through its `goal.updated` event instead.
 */
export async function runGoalCommand(
  client: Pick<SwitchbackClient, 'request'>,
  session: { id: string; goal?: GoalInfo },
  view: Pick<ViewState, 'goal'>,
  args: string[],
): Promise<string | undefined> {
  const cmd = parseGoalCommand(args);
  if (cmd.kind === 'show') return goalStatus(sessionGoal(view, session));
  try {
    const set = await client.request('session.setGoal', {
      sessionId: session.id,
      objective: cmd.kind === 'set' ? cmd.objective : null,
    });
    return set.goal ? undefined : 'no goal is running';
  } catch (err) {
    return `goal: ${(err as Error).message}`;
  }
}
