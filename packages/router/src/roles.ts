/**
 * Reading roles (ADR 0015): one place for how `routing.start` and
 * `routing.escalate` form a ladder, and for the budget check every remote
 * call goes through. Pure, like the router.
 */
import type { BudgetConfig, RoutingConfig } from './config.ts';

type Roles = Pick<RoutingConfig, 'start' | 'escalate'>;

/** The ladder's steps as chains: 0 is `start`, then each `escalate` step. */
export function ladderSteps(roles: Roles): string[][] {
  return [roles.start, ...roles.escalate];
}

/** Every alias in a role, once, in role order. */
export function roleAliases(roles: Roles): string[] {
  return [...new Set(ladderSteps(roles).flat())];
}

/** The step whose chain lists `alias`, or 0 when it's in none. */
export function stepOf(roles: Roles, alias: string): number {
  return Math.max(
    0,
    ladderSteps(roles).findIndex((chain) => chain.includes(alias)),
  );
}

/** Why remote spend has to stop, or undefined while the budget allows it. */
export function budgetReached(
  budget: Pick<BudgetConfig, 'dailyUsd' | 'monthlyUsd'>,
  spend: { todayUsd: number; monthUsd: number },
): string | undefined {
  if (budget.dailyUsd !== undefined && spend.todayUsd >= budget.dailyUsd)
    return `daily remote budget of $${budget.dailyUsd.toFixed(2)} reached`;
  if (budget.monthlyUsd !== undefined && spend.monthUsd >= budget.monthlyUsd)
    return `monthly remote budget of $${budget.monthlyUsd.toFixed(2)} reached`;
  return undefined;
}
