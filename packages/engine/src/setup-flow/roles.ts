/** Setup: which model does what (ADR 0015). */
import type { SessionRoles } from '@switchback/protocol';
import { defaultRoles, type PlannedModel, type Roles } from '../setup.ts';
import { SetupError, type SetupFlags } from './flags.ts';
import { asking, type SetupPrompter } from './prompter.ts';

/** A role reference (`alias` or model ID) to the alias setup gives that model. */
export function resolveAlias(plan: PlannedModel[], ref: string, flag: string): string {
  const hit = plan.find((m) => m.alias === ref) ?? plan.find((m) => m.model === ref);
  if (!hit)
    throw new SetupError(
      `${flag} "${ref}" isn't one of the chosen models (${plan.map((m) => m.alias).join(', ')})`,
    );
  return hit.alias;
}

/** Which model does what: flags unattended, else defaults the user can change. */
export async function chooseRoles(
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
  plan: PlannedModel[],
): Promise<Roles> {
  const p = asking(ui);
  const roles = defaultRoles(plan);
  const chain = (v: string, flag: string) =>
    v.split(',').map((ref) => resolveAlias(plan, ref.trim(), flag));
  if (flags.start?.length) roles.start = flags.start.flatMap((v) => chain(v, '--start'));
  if (flags.escalate) roles.escalate = flags.escalate.map((v) => chain(v, '--escalate'));
  if (flags.reviewers)
    roles.review =
      flags.reviewers === 'off' || flags.reviewers === 'ladder'
        ? flags.reviewers
        : chain(flags.reviewers, '--reviewers').map((alias) => [alias]);
  if (flags.subagentModel)
    roles.subagents = resolveAlias(plan, flags.subagentModel, '--subagent-model');
  if (!p) return roles;

  // Clients show them exactly as `/roles` and `switchback doctor` do.
  const models = plan.map((m) => ({
    alias: m.alias,
    ref: { provider: m.where, model: m.model },
    tier: m.tier,
  }));
  const asSession = (): SessionRoles => ({
    start: roles.start,
    escalate: roles.escalate,
    review:
      roles.review === 'off'
        ? { mode: 'off', models: [] }
        : { mode: 'auto', models: roles.review === 'ladder' ? [] : roles.review },
    ...(roles.subagents ? { subagents: roles.subagents } : {}),
    overridden: [],
  });
  for (;;) {
    p.note({ kind: 'text', text: 'Which model does what', tone: 'heading' });
    p.note({ kind: 'roles', roles: asSession(), models });
    const action = await p.select('Which model does what', [
      { label: 'Looks good', value: 'done' as const },
      { label: 'Change where turns start', value: 'start' as const },
      { label: 'Change the escalation ladder', value: 'escalate' as const },
      { label: 'Change who reviews edits', value: 'review' as const },
      { label: 'Change the subagent model', value: 'subagents' as const },
    ]);
    if (action === 'done') return roles;
    if (action === 'start') {
      const first = await pickModel(p, plan, 'Which model should turns start on?', []);
      if (!first) continue;
      roles.start = [first];
      for (;;) {
        const backup = await pickModel(
          p,
          plan,
          'Add a backup start model? It takes over when the first is down or a prompt is too big for it.',
          roles.start,
          'No more',
        );
        if (!backup) break;
        roles.start.push(backup);
      }
      roles.escalate = roles.escalate.filter((step) => !step.some((a) => roles.start.includes(a)));
    }
    if (action === 'escalate') {
      roles.escalate = [];
      for (;;) {
        const next = await pickModel(
          p,
          plan,
          roles.escalate.length
            ? 'If that one struggles too, escalate to:'
            : 'When the start model struggles, escalate to:',
          [...roles.start, ...roles.escalate.flat()],
          roles.escalate.length ? 'Nothing more' : 'Nothing: no escalation',
        );
        if (!next) break;
        roles.escalate.push([next]);
      }
    }
    if (action === 'review') {
      const how = await p.select('Review edits automatically?', [
        { label: 'No', value: 'off' as const },
        ...(roles.escalate.length
          ? [
              {
                label: 'Yes, with the escalation ladder',
                value: 'ladder' as const,
                hint: 'the first reviews; the next steps in when its findings stand',
              },
            ]
          : []),
        { label: 'Yes, with models I choose', value: 'choose' as const },
      ]);
      if (how !== 'choose') roles.review = how;
      else {
        const reviewers: string[][] = [];
        for (;;) {
          const next = await pickModel(
            p,
            plan,
            reviewers.length
              ? "If that reviewer's findings still stand after a fix, the next reviewer:"
              : 'Who reviews first? (A model never reviews its own edits.)',
            reviewers.flat(),
            reviewers.length ? 'No more' : 'Cancel',
          );
          if (!next) break;
          reviewers.push([next]);
        }
        if (reviewers.length) roles.review = reviewers;
      }
    }
    if (action === 'subagents') {
      const pick = await p.select('Which model should subagents use when their agent names none?', [
        { label: 'Normal routing', value: '' },
        ...plan.map((m) => ({ label: m.alias, value: m.alias, hint: `${m.model} · ${m.tier}` })),
      ]);
      roles.subagents = pick || undefined;
    }
  }
}

/** One model from the plan, leaving out `taken`; undefined for the "none" choice. */
export async function pickModel(
  p: SetupPrompter,
  plan: PlannedModel[],
  question: string,
  taken: string[],
  none = 'Cancel',
): Promise<string | undefined> {
  const options = plan
    .filter((m) => !taken.includes(m.alias))
    .map((m) => ({
      label: m.alias,
      value: m.alias,
      hint: [
        m.tier,
        m.where,
        m.contextWindow ? `ctx ${m.contextWindow.toLocaleString('en-US')}` : undefined,
        m.inputPrice !== undefined
          ? `$${m.inputPrice}/M in`
          : m.tier === 'local'
            ? 'free'
            : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    }));
  const pick = await p.select(question, [...options, { label: none, value: '' }]);
  return pick || undefined;
}
