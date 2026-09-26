import { z } from 'zod';
import { defineTool, ToolError } from './tool.ts';

export const taskTool = defineTool({
  name: 'task',
  description:
    'Delegate a self-contained task to a subagent. The subagent starts with a fresh context, works independently, and returns only its final report. Launch several in one response to run them in parallel. Give each a complete brief: it cannot see this conversation.',
  schema: z.object({
    agent: z.string().describe('Agent name from the list below'),
    description: z.string().describe('3-5 word label shown to the user'),
    prompt: z.string().describe('Complete, self-contained instructions for the subagent'),
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
    const result = await ctx.runSubagent(input.agent, input.prompt, input.description);
    if (!result.ok) throw new ToolError(`subagent failed: ${result.text}`);
    return result.text || '(subagent returned no text)';
  },
});
