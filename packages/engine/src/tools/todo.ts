import { z } from 'zod';
import { defineTool } from './tool.ts';

export const TodoItem = z.object({
  text: z.string().min(1).max(300),
  status: z.enum(['pending', 'in_progress', 'done']),
});

/**
 * The model's working plan for a longer task. Each call replaces the whole
 * list; clients show the latest one (they read it from the call itself, so
 * it needs no state of its own and survives resuming the session).
 */
export const todoTool = defineTool({
  name: 'todo',
  description:
    'Keep a short checklist for multi-step work: write the steps, mark one in_progress while you work on it, and done when it is. Each call replaces the whole list. The user sees it. Skip it for small tasks.',
  schema: z.object({ items: z.array(TodoItem).min(1).max(50) }),
  permission: 'none',
  mutating: false,
  summarize: (i) => `update the checklist (${i.items.length} items)`,
  async run(input) {
    const count = (s: string) => input.items.filter((i) => i.status === s).length;
    return `checklist: ${count('done')} done, ${count('in_progress')} in progress, ${count('pending')} to do`;
  },
});
