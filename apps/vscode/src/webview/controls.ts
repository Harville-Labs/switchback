/** The controls row under the composer, as HTML (pure, so it can be tested). */
import {
  formatReviewers,
  formatSteps,
  MODE_DESCRIPTIONS,
  modeLabel,
} from '@switchback/client/format';
import { choiceLabel, modelChoices } from '@switchback/client/models';
import type {
  InitializeResult,
  PermissionMode,
  RoutePreference,
  SessionRoles,
} from '@switchback/protocol';
import { esc } from './render.ts';

const ROUTES: { value: RoutePreference; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Run on the current model; escalate when it struggles' },
  { value: 'local', label: 'Local', title: 'Only local models for the next prompts' },
  { value: 'remote', label: 'Remote', title: 'Only hosted models for the next prompts' },
];

export interface ControlsState {
  route: RoutePreference;
  mode: PermissionMode;
  agent: string;
  roles: SessionRoles | undefined;
  /** Every configured model, for the current-model dropdown. */
  models: InitializeResult['models'];
  /** The ladder step the last call ran on; 0 is the current model. */
  ladderStep: number;
}

/** Dropdown values that aren't model aliases. */
export const CHOOSE_MODELS = ':choose';
export const SAVE_DEFAULT = ':save';

/**
 * The current model as a dropdown, like a chat model picker: pick a model and
 * the session's next prompt runs on it. Models that were current stay behind
 * it as backups (`currentChange`), and escalation still climbs from it.
 */
export function renderModelSelect(roles: SessionRoles, models: InitializeResult['models']): string {
  const choices = modelChoices(models, roles);
  const first = roles.current[0];
  const options = choices.map(
    (c) =>
      `<option value="${esc(c.alias)}"${c.current ? ' selected' : ''}>${esc(choiceLabel(c))}</option>`,
  );
  // A current model that isn't configured any more still shows what it is.
  if (!first) options.unshift('<option value="" selected disabled>none</option>');
  else if (!choices.some((c) => c.current))
    options.unshift(`<option value="${esc(first)}" selected>${esc(first)}</option>`);
  const extra = [
    `<option value="${CHOOSE_MODELS}">Backups and other roles…</option>`,
    ...(roles.overridden.includes('current')
      ? [`<option value="${SAVE_DEFAULT}">Make this my default</option>`]
      : []),
  ];
  const title =
    'The current model: your prompts run on it, and escalate up the ladder when it struggles';
  return `<label class="pill model" title="${esc(title)}"><span class="k">Model</span><select data-current aria-label="Current model">${options.join('')}<option disabled>──────────</option>${extra.join('')}</select></label>`;
}

/** Routing, mode, agent, and the models in each role, each one click from its picker. */
export function renderControls({
  route,
  mode,
  agent,
  roles,
  models,
  ladderStep,
}: ControlsState): string {
  const pill = (attrs: string, key: string, value: string, title: string) =>
    `<button class="pill" ${attrs} title="${esc(title)}"><span class="k">${key}</span> ${value}</button>`;
  const routes = `<span class="segmented">${ROUTES.map(
    (r) =>
      `<button class="${r.value === route ? 'on' : ''}" data-route="${r.value}" title="${esc(r.title)}">${r.label}</button>`,
  ).join('')}</span>`;
  // The model first: it's what people change most.
  const parts = roles ? [renderModelSelect(roles, models), routes] : [routes];
  parts.push(
    pill('data-mode', 'Mode', esc(modeLabel(mode)), `${MODE_DESCRIPTIONS[mode]} (click to change)`),
  );
  if (agent)
    parts.push(pill('data-agent', 'Agent', esc(agent), 'Start a new session with another agent'));
  if (roles) {
    // The step the last call ran on is highlighted while the session is up the ladder.
    const here = ladderStep;
    const ladder = roles.escalate
      .map((step, i) => {
        const text = esc(formatSteps([step]));
        return i + 1 === here ? `<span class="here">${text}</span>` : text;
      })
      .join(' → ');
    parts.push(
      pill(
        'data-role="escalate"',
        'Escalate',
        ladder || 'none',
        'The escalation ladder, one step per escalation',
      ),
      pill('data-role="review"', 'Review', esc(formatReviewers(roles)), 'Who reviews edits'),
    );
    if (roles.escalate.length)
      parts.push(
        `<button class="pill up" data-escalate-now title="A stronger model takes over: the next step of this turn, or your next prompt (/up)">↑ Escalate now</button>`,
      );
  }
  return parts.join('');
}
