import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';

export const EXIT_PLAN_MODE = 'exit_plan_mode';

/**
 * Plan mode's way out: the model presents its plan, and the user approves it
 * (the session leaves plan mode) or asks for changes. Always in the tool list
 * of a top-level session, so the cache prefix doesn't change with the mode.
 */
export const exitPlanModeTool = defineTool({
  name: EXIT_PLAN_MODE,
  description:
    'Use only in plan mode, once you have a complete plan: present it to the user for approval. Approved, you may start making changes; otherwise revise the plan with the feedback.',
  schema: z.object({
    plan: z
      .string()
      .min(1)
      .describe('The plan, in Markdown: what you will change and why, step by step'),
  }),
  permission: 'none',
  mutating: true,
  summarize: () => 'present the plan',
  async run(input, ctx) {
    if (!ctx.approvePlan) throw new ToolError('plan approval is not available here');
    const answer = await ctx.approvePlan(input.plan);
    switch (answer) {
      case 'not-planning':
        throw new ToolError('Plan mode is not on; go ahead without presenting a plan.');
      case 'approved':
        return 'The user approved the plan. Plan mode is off; make the changes.';
      case 'approved-accept-edits':
        return 'The user approved the plan and will accept your edits without asking. Make the changes.';
      case 'rejected':
        return 'The user did not approve the plan. Stay in plan mode: ask what to change, or revise the plan and present it again.';
    }
  },
});
