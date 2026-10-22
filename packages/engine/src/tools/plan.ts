import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';

export const EXIT_PLAN_MODE = 'exit_plan_mode';

/**
 * A planning agent's way out: the model presents its plan, and the user
 * approves it (the session switches back to the agent it worked as before)
 * or asks for changes. Always in the tool list of a top-level session, so the
 * cache prefix doesn't change with the agent; only an agent that lists it in
 * `tools` can use it (ADR 0029).
 */
export const exitPlanModeTool = defineTool({
  name: EXIT_PLAN_MODE,
  description:
    'Use only as a planning agent, once you have a complete plan: present it to the user for approval. Approved, you may start making changes; otherwise revise the plan with the feedback.',
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
        throw new ToolError(
          "You aren't working as a planning agent; go ahead without presenting a plan.",
        );
      case 'approved':
        return 'The user approved the plan, and the session has left the planning agent. Make the changes.';
      case 'approved-auto':
        return 'The user approved the plan, and the session has left the planning agent. Calls that would ask are now judged automatically. Make the changes.';
      case 'rejected':
        return 'The user did not approve the plan. Keep planning: ask what to change, or revise the plan and present it again.';
    }
  },
});
