import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';

/**
 * How the model ends a `/goal` (ADR 0024): a tool call rather than a phrase
 * in its reply, so "done" can't be matched by accident.
 */
export const goalTool = defineTool({
  name: 'goal',
  description:
    'End the goal the user set with /goal: "done" when it is met, "blocked" when you can\'t go on without the user. Only while a goal is active.',
  schema: z.object({
    status: z.enum(['done', 'blocked']),
    summary: z
      .string()
      .min(1)
      .max(500)
      .describe('What was done, or what you need; the user sees it'),
  }),
  permission: 'none',
  mutating: false,
  summarize: (i) => `goal ${i.status}: ${i.summary}`,
  async run(input, ctx) {
    if (!ctx.reportGoal) throw new ToolError('goals are not available here');
    if (!ctx.reportGoal(input.status, input.summary))
      throw new ToolError('there is no active goal; the user starts one with /goal');
    return input.status === 'done'
      ? 'Goal marked done. Finish your reply to the user.'
      : 'Goal marked blocked. Tell the user what you need, then end your turn.';
  },
});
