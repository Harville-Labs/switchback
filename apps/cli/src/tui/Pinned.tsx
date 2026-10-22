/** What stays above the prompt while it matters: the goal, the model's checklist, queued prompts. */
import { goalLine, type ViewState } from '@switchback/client';
import type { GoalInfo } from '@switchback/protocol';
import { Text } from 'ink';
import { Queue, Todos } from './Chrome.tsx';
import { useTheme } from './theme.ts';

export function Pinned({ view, goal }: { view: ViewState; goal: GoalInfo | undefined }) {
  const t = useTheme();
  return (
    <>
      {goal?.status === 'active' ? (
        <Text color={t.accent} wrap="truncate-end">
          {'  '}
          {goalLine(goal)}
        </Text>
      ) : null}
      {view.todos?.some((todo) => todo.status !== 'done') ? <Todos todos={view.todos} /> : null}
      {view.queue?.length ? <Queue queue={view.queue} /> : null}
    </>
  );
}
