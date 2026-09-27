import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';

export const taskTool = defineTool({
  name: 'task',
  description:
    'Delegate a self-contained task to a subagent. The subagent starts with a fresh context, works independently, and returns only its final report. Launch several in one response to run them in parallel. Give each a complete brief: it cannot see this conversation. With background: true the call returns at once and the report arrives later as a message, so you can keep working meanwhile.',
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
    if (input.background) {
      const started = await ctx.runSubagent(input.agent, input.prompt, input.description, {
        background: true,
        ...(input.isolation ? { isolation: input.isolation } : {}),
      });
      return `Started background task ${started.sessionId} (${input.agent}: ${input.description}). Its report will arrive as a message when it finishes; continue with other work and don't wait for it.`;
    }
    const result = await ctx.runSubagent(
      input.agent,
      input.prompt,
      input.description,
      input.isolation ? { isolation: input.isolation } : {},
    );
    if (!result.ok) throw new ToolError(`subagent failed: ${result.text}`);
    return result.text || '(subagent returned no text)';
  },
});
