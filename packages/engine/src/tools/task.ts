import { EffortLevel } from '@switchback/protocol';
import { z } from 'zod';
import { defineTool, ToolError, truncate } from './tool.ts';

/** A subagent's report to its parent is cut at this length. */
const REPORT_CHARS = 30_000;

export const taskTool = defineTool({
  name: 'task',
  description:
    'Delegate a self-contained task to a subagent. The subagent starts with a fresh context, works independently, and returns only its final report. Launch several in one response to run them in parallel. Give each a complete brief (the goal, the files it owns, what to report): it cannot see this conversation. With background: true the call returns at once and the report arrives later as a message, so you can keep working meanwhile.',
  schema: z.object({
    agent: z.string().describe('Agent name from the list below'),
    description: z.string().describe('3-5 word label shown to the user'),
    prompt: z.string().describe('Complete, self-contained instructions for the subagent'),
    background: z
      .boolean()
      .optional()
      .describe('Run without waiting; the report arrives later as a message'),
    isolation: z
      .enum(['worktree'])
      .optional()
      .describe(
        'Work in a separate git worktree and branch, so parallel editors never conflict; the report includes the branch and diff to merge',
      ),
    effort: EffortLevel.optional().describe(
      "Reasoning effort for this task: low for lookups and mechanical edits, high or above for hard debugging or design. Omit to use the agent's default",
    ),
    model: z
      .string()
      .optional()
      .describe(
        "A configured model alias to run this task on, instead of the agent's default. Omit unless the task needs a specific model",
      ),
  }),
  permission: 'none',
  mutating: false,
  summarize: (i) => `${i.agent}: ${i.description}`,
  async run(input, ctx) {
    if (!ctx.runSubagent) throw new ToolError('subagent depth limit reached; do the work directly');
    if (!ctx.agentCatalog.some((a) => a.name === input.agent))
      throw new ToolError(
        `unknown agent "${input.agent}"; available: ${ctx.agentCatalog.map((a) => a.name).join(', ')}`,
      );
    const { agent, prompt, description, ...options } = input;
    if (input.background) {
      const started = await ctx.runSubagent(agent, prompt, description, options);
      return `Started background task ${started.sessionId} (${agent}: ${description}). Its report will arrive as a message when it finishes; continue with other work and don't wait for it.`;
    }
    const result = await ctx.runSubagent(agent, prompt, description, options);
    // Reports share the parent's context with every other subagent's; the rest is in its tab.
    const report = truncate(result.text, REPORT_CHARS);
    if (!result.ok) throw new ToolError(`subagent failed: ${report}`);
    return report || '(subagent returned no text)';
  },
});
