import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';

/**
 * The model's way up the escalation ladder: it records the request, and the
 * router decides on the next call (rule `model-escalation`), following
 * `escalation.policy`, budgets, and privacy like any other escalation.
 */
export const escalateTool = defineTool({
  name: 'escalate',
  description:
    'Hand the rest of this task to a stronger model: use when you keep failing, the task needs deeper reasoning than you can give, or you are unsure of a change that matters. Your next step runs on the next model up, if one is configured and allowed; the user may be asked first. Not for routine work.',
  schema: z.object({
    reason: z
      .string()
      .min(1)
      .max(300)
      .describe('Why a stronger model is needed, in one sentence; the user sees it'),
  }),
  permission: 'none',
  mutating: false,
  summarize: (i) => `escalate: ${i.reason}`,
  async run(input, ctx) {
    if (!ctx.requestEscalation) throw new ToolError('escalation is not available here');
    ctx.requestEscalation(input.reason);
    return 'Requested. Your next step runs on a stronger model if one is configured and allowed; otherwise it stays here. Continue the task.';
  },
});
