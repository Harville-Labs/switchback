/**
 * Choosing a model for a role: the TUI's `/current` and `/model` pickers and
 * VS Code's model dropdown all list the same choices and make the same change.
 */
import type {
  ConfigReloadResult,
  InitializeResult,
  ModelsRefreshResult,
  SessionRoles,
  SessionSetRolesParams,
} from '@switchback/protocol';
import type { SwitchbackClient } from './client.ts';
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

/**
 * Tab in the TUI: the model after the current one, in config order and back
 * to the first after the last, with the change that makes it current. It takes
 * the current model's place, so going round doesn't pile every model into the
 * backups. Undefined when there's no other model to switch to.
 */
export function nextModel(
  models: ModelSummary[],
  roles: SessionRoles | undefined,
): { alias: string; change: Pick<SessionSetRolesParams, 'current'> } | undefined {
  const at = models.findIndex((m) => m.alias === roles?.current[0]);
  const next = models[(at + 1) % models.length];
  if (!next || next.alias === roles?.current[0]) return undefined;
  const backups = (roles?.current ?? []).slice(1).filter((a) => a !== next.alias);
  return { alias: next.alias, change: { current: [next.alias, ...backups] } };
}

/** One choice on one line: `qwen3-coder · local · step 1`. */
export function choiceLabel(c: ModelChoice): string {
  const model = c.model === c.alias ? c.alias : `${c.alias} (${c.model})`;
  return [model, c.tier, ...c.roles].join(' · ');
}

/** `/models refresh`: what each endpoint and plan lists now that it didn't, or why it couldn't say. */
export function formatRefresh(result: ModelsRefreshResult): string {
  if (!result.sources.length)
    return 'Nothing to refresh: no OpenAI-compatible endpoint or subscription is set up to list its models.';
  const lines = result.sources.map((s) => {
    if (s.error) return `  ${s.provider}: couldn't ask (${s.error}); its last list stays`;
    const changes = [
      ...(s.added.length ? [`new ${s.added.join(', ')}`] : []),
      ...(s.removed.length ? [`gone ${s.removed.join(', ')}`] : []),
    ];
    return `  ${s.provider}: ${changes.length ? changes.join('; ') : 'no change'}`;
  });
  return [`${result.models.length} models available.`, ...lines].join('\n');
}

/** `/reload` in either client: ask the engine to read its config again, and say what came of it. */
export function runReload(client: Pick<SwitchbackClient, 'request'>): Promise<string> {
  return client.request('config.reload', {}).then(formatReload, (err: Error) => err.message);
}

/** Which parts of the config changed, if any. */
export function formatReload(result: ConfigReloadResult): string {
  if (!result.changed.length) return 'Config reloaded; nothing in it changed.';
  return `Config reloaded. Changed: ${result.changed.join(', ')}. ${result.models.length} models available.`;
}
