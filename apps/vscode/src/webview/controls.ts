/** The controls row under the composer, as HTML (pure, so it can be tested). */
import {
  formatReviewers,
  formatSteps,
  MODE_DESCRIPTIONS,
  modeLabel,
} from '@switchback/client/format';
import type { PermissionMode, RoutePreference, SessionRoles } from '@switchback/protocol';
import { esc } from './render.ts';

const ROUTES: { value: RoutePreference; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Start on the start model; escalate when it struggles' },
  { value: 'local', label: 'Local', title: 'Only local models for the next prompts' },
  { value: 'remote', label: 'Remote', title: 'Only hosted models for the next prompts' },
];

export interface ControlsState {
  route: RoutePreference;
  mode: PermissionMode;
  agent: string;
  roles: SessionRoles | undefined;
  /** The ladder step the last call ran on; 0 is the start model. */
  ladderStep: number;
}

/** Routing, mode, agent, and the models in each role, each one click from its picker. */
export function renderControls({ route, mode, agent, roles, ladderStep }: ControlsState): string {
  const pill = (attrs: string, key: string, value: string, title: string) =>
    `<button class="pill" ${attrs} title="${esc(title)}"><span class="k">${key}</span> ${value}</button>`;
  const routes = `<span class="segmented">${ROUTES.map(
    (r) =>
      `<button class="${r.value === route ? 'on' : ''}" data-route="${r.value}" title="${esc(r.title)}">${r.label}</button>`,
  ).join('')}</span>`;
  const parts = [routes];
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
        'data-role="start"',
        'Start',
        esc(formatSteps([roles.start]) || 'none'),
        'Where turns start',
      ),
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
