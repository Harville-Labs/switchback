/**
 * QuickPick flows that change a session: roles (ADR 0015), review, and the
 * agent for a new session. Shared by the command palette and the chat view.
 */
import { formatReviewers, formatSteps } from '@switchback/client';
import type { InitializeResult, SessionRoles, SessionSetRolesParams } from '@switchback/protocol';
import * as vscode from 'vscode';
import type { EngineConnection } from './connection.ts';
import type { RoleName } from './messages.ts';

type Models = InitializeResult['models'];

export async function chooseReview(engine: EngineConnection): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'On',
        value: true,
        detail:
          'After a model edits files, a reviewer checks the diff; the model fixes what it finds. Choose reviewers with "Choose Models for This Session".',
      },
      { label: 'Off', value: false, detail: 'No reviews in this window.' },
      {
        label: 'Follow config',
        value: undefined,
        detail: 'Use review.mode from your Switchback config.',
      },
    ],
    { title: 'Switchback: Review of Local Edits' },
  );
  if (pick) engine.remoteReview = pick.value;
}

/** Change which model does what in this session: pick a role, then its models. */
export async function chooseModels(engine: EngineConnection): Promise<void> {
  const roles = await engine.currentRoles();
  if (!roles) return;
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: 'Start with',
        description: formatSteps([roles.start]) || 'none',
        role: 'start' as const,
      },
      {
        label: 'Escalate to',
        description: formatSteps(roles.escalate) || 'nothing',
        role: 'escalate' as const,
      },
      { label: 'Review edits', description: formatReviewers(roles), role: 'review' as const },
      {
        label: 'Subagents use',
        description: roles.subagents ?? 'normal routing',
        role: 'subagents' as const,
      },
      ...(roles.overridden.length
        ? [{ label: 'Follow my config again', description: '', role: 'reset' as const }]
        : []),
    ],
    { title: 'Switchback: Models for This Session' },
  );
  if (pick) await chooseRole(engine, pick.role);
}

/**
 * Change one role for this session with QuickPicks, then offer to save it
 * as the default. Used by the command and by the chat view's role buttons.
 */
export async function chooseRole(
  engine: EngineConnection,
  role: RoleName | 'reset',
): Promise<void> {
  const { client, session } = engine;
  const roles = await engine.currentRoles();
  if (!client || !session || !roles) return;
  const models = engine.init?.models ?? [];
  const change = await roleChange(engine, role, roles, models);
  if (!change) return;
  try {
    await client.request('session.setRoles', { sessionId: session.id, ...change });
    if (change.reset) return;
    const save = await vscode.window.showInformationMessage(
      'Changed for this session.',
      'Save as Default',
    );
    if (save) {
      const r = await client.request('session.setRoles', { sessionId: session.id, save: true });
      void vscode.window.showInformationMessage(`Saved as your default in ${r.savedTo}.`);
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Switchback: ${(err as Error).message}`);
  }
}

async function roleChange(
  engine: EngineConnection,
  role: RoleName | 'reset',
  roles: SessionRoles,
  models: Models,
): Promise<Omit<SessionSetRolesParams, 'sessionId'> | undefined> {
  switch (role) {
    case 'reset':
      return { reset: true };
    case 'start': {
      const start = await pickOrdered('Start with (then backups, in order)', models, [], false);
      return start?.length ? { start } : undefined;
    }
    case 'escalate': {
      const ladder = await pickOrdered('Escalate to (in order)', models, roles.start, true);
      return ladder ? { escalate: ladder.map((a) => [a]) } : undefined;
    }
    case 'review': {
      const change = await reviewChange(roles, models);
      // The session's review mode now decides, not this window's on/off override.
      if (change) engine.remoteReview = undefined;
      return change;
    }
    case 'subagents': {
      const sub = await vscode.window.showQuickPick(
        [
          { label: 'Normal routing', value: null },
          ...models.map((m) => ({
            label: m.alias,
            description: `${m.ref.model} · ${m.tier}`,
            value: m.alias,
          })),
        ],
        { title: 'Switchback: Subagent Model' },
      );
      return sub ? { subagents: sub.value } : undefined;
    }
  }
}

async function reviewChange(
  roles: SessionRoles,
  models: Models,
): Promise<Omit<SessionSetRolesParams, 'sessionId'> | undefined> {
  const how = await vscode.window.showQuickPick(
    [
      { label: 'Off', value: 'off' as const },
      {
        label: 'The escalation ladder',
        description: formatSteps(roles.escalate),
        value: 'ladder' as const,
      },
      { label: 'Models I choose…', value: 'choose' as const },
    ],
    { title: 'Switchback: Review Edits' },
  );
  if (how?.value === 'off') return { review: { mode: 'off' } };
  if (how?.value === 'ladder') return { review: { mode: 'auto', models: [] } };
  if (how?.value !== 'choose') return undefined;
  const reviewers = await pickOrdered('Reviewers (in order)', models, [], false);
  return reviewers?.length
    ? { review: { mode: 'auto', models: reviewers.map((a) => [a]) } }
    : undefined;
}

/** Start a new session with an agent the user picks. */
export async function chooseAgent(engine: EngineConnection): Promise<void> {
  const agents = engine.init?.agents ?? [];
  const pick = await vscode.window.showQuickPick(
    agents.map((a) => ({
      label: a.name,
      description: a.route !== 'auto' ? a.route : (a.model ?? ''),
      detail: a.description,
    })),
    { title: 'Switchback: New Session with Agent', matchOnDetail: true },
  );
  if (pick) await engine.newSession(pick.label);
}

/** Models picked one at a time, in order; undefined when cancelled. */
async function pickOrdered(
  title: string,
  models: Models,
  exclude: string[],
  allowNone: boolean,
): Promise<string[] | undefined> {
  const chosen: string[] = [];
  for (;;) {
    const items = [
      ...models
        .filter((m) => !chosen.includes(m.alias) && !exclude.includes(m.alias))
        .map((m) => ({ label: m.alias, description: `${m.ref.model} · ${m.tier}`, done: false })),
      ...(chosen.length || allowNone
        ? [
            {
              label: chosen.length ? '$(check) Done' : '$(close) None',
              description: '',
              done: true,
            },
          ]
        : []),
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: `Switchback: ${title}`,
      placeHolder: chosen.length ? `So far: ${chosen.join(' → ')}. Next?` : 'First?',
    });
    if (!pick) return undefined;
    if (pick.done) return chosen;
    chosen.push(pick.label);
  }
}
