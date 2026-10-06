import { expect, test } from 'bun:test';
import { todoTool } from './todo.ts';

test('the todo tool replaces the list and reports where it stands', async () => {
  const ctx = {
    workspaceRoot: '/tmp',
    sessionId: 's',
    signal: new AbortController().signal,
    agentCatalog: [],
  };
  const out = await todoTool.run(
    {
      items: [
        { text: 'a', status: 'done' },
        { text: 'b', status: 'in_progress' },
        { text: 'c', status: 'pending' },
        { text: 'd', status: 'pending' },
      ],
    },
    ctx,
  );
  expect(out).toBe('checklist: 1 done, 1 in progress, 2 to do');
  expect(todoTool.schema.safeParse({ items: [] }).success).toBe(false);
});
