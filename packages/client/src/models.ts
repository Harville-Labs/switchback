/**
 * Choosing a model for a role: the TUI's `/current` and `/model` pickers and
 * VS Code's model dropdown all list the same choices and make the same change.
 */
import type { InitializeResult, SessionRoles, SessionSetRolesParams } from '@switchback/protocol';
import { rolesOfModel } from './format.ts';

type ModelSummary = InitializeResult['models'][number];

export interface ModelChoice {
  alias: string;
  /** The provider's model ID, as people know it. */
  model: string;
  tier: ModelSummary['tier'];
  /** Fills the role being chosen: first in the current chain, or the subagent model. */
  current: boolean;
  /** The other roles it fills (`step 1`, `reviews`, ...), for a hint beside it. */
  roles: string[];
}

export type ChosenRole = 'current' | 'subagents';

/** Every configured model, the one filling `role` first, then in config order. */
export function modelChoices(
  models: ModelSummary[],
  roles?: SessionRoles,
  role: ChosenRole = 'current',
): ModelChoice[] {
  const first = role === 'current' ? roles?.current[0] : roles?.subagents;
  const choices = models.map((m) => ({
    alias: m.alias,
    model: m.ref.model,
    tier: m.tier,
    current: m.alias === first,
    roles: roles ? rolesOfModel(m.alias, roles).filter((r) => r !== role) : [],
  }));
  return [...choices.filter((c) => c.current), ...choices.filter((c) => !c.current)];
}

/**
 * The change that makes `alias` the current model. The models that were
 * current stay behind it as backups, in order, so picking a model never drops
 * the fallback for when it's down or a prompt is too big for it.
 */
export function currentChange(
  roles: SessionRoles | undefined,
  alias: string,
): Pick<SessionSetRolesParams, 'current'> {
  return { current: [alias, ...(roles?.current ?? []).filter((a) => a !== alias)] };
}

/** One choice on one line: `qwen3-coder · local · step 1`. */
export function choiceLabel(c: ModelChoice): string {
  const model = c.model === c.alias ? c.alias : `${c.alias} (${c.model})`;
  return [model, c.tier, ...c.roles].join(' · ');
}
