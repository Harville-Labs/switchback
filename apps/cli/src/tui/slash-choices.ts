/** The lists commands open when run with no argument (`ChoicePicker`). */
import { sessionAgent, sessionEffort, subagentList, switchableAgents } from '@switchback/client';
import { EffortLevel } from '@switchback/protocol';
import type { ChoiceList } from './ChoicePicker.tsx';
import { type SlashContext, say } from './slash-context.ts';
import { THEME_NAMES } from './theme.ts';

export function themeChoices(ctx: SlashContext): ChoiceList {
  return {
    title: 'Theme',
    command: 'theme',
    choices: THEME_NAMES.map((n) => ({ value: n, current: n === ctx.theme })),
  };
}

export function effortChoices(ctx: SlashContext): ChoiceList {
  const effort = sessionEffort(ctx.view, ctx.session);
  return {
    title: "How hard this session's models reason",
    command: 'effort',
    choices: [
      ...EffortLevel.options.map((e) => ({ value: e, current: e === effort })),
      { value: 'default', detail: 'follow the agent and each model', current: !effort },
    ],
  };
}

export const REVIEW_CHOICES: ChoiceList = {
  title: 'Review of edits',
  command: 'review',
  choices: [
    { value: 'on', detail: 'a reviewer checks the diff after a model edits files' },
    { value: 'off' },
    { value: 'default', detail: 'follow review.mode in config' },
    { value: 'ladder', detail: 'review is on, and the escalation ladder reviews' },
  ],
};

/** Agents that run sessions, asked for each time so ones created meanwhile show up. */
export async function agentChoices(ctx: SlashContext): Promise<ChoiceList> {
  const agents = await ctx.client.request('agents.list', {}).catch(() => ctx.init.agents);
  const current = sessionAgent(ctx.view, ctx.session);
  return {
    title: 'Agent',
    command: 'agent',
    choices: switchableAgents(agents).map((a) => ({
      value: a.name,
      detail: a.description,
      current: a.name === current,
    })),
  };
}

export function subagentChoices(ctx: SlashContext): ChoiceList | undefined {
  const all = subagentList(ctx.view);
  if (!all.length) {
    say(ctx, 'no subagents in this session yet');
    return undefined;
  }
  return {
    title: 'Subagent',
    command: 'subagent',
    choices: all.map((x, i) => ({
      value: String(i + 1),
      label: `${'  '.repeat(x.depth)}${x.row.agent}: ${x.row.task}`,
      detail: x.row.status,
    })),
  };
}
