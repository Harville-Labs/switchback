/** `switchback sessions`: this workspace's saved sessions, newest first, for people and scripts. */
import { type CommonFlags, createEngine } from '../bootstrap.ts';
import { ago } from '../tui/SessionPicker.tsx';

export async function sessions(flags: CommonFlags & { json: boolean }): Promise<number> {
  const { engine } = createEngine(flags, 'deny');
  const list = engine.listSessions();
  await engine.shutdown();
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return 0;
  }
  if (!list.length) {
    process.stdout.write('No saved sessions in this workspace yet.\n');
    return 0;
  }
  for (const s of list)
    process.stdout.write(
      `${s.id}  ${s.title || '(untitled)'}  ${s.agent} · ${ago(s.updatedAt)} · $${s.costUsd.toFixed(3)}\n`,
    );
  process.stdout.write(
    '\nswitchback --session <id> resumes one; switchback --resume picks from a list.\n',
  );
  return 0;
}
