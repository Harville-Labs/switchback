/** `harness run "<prompt>"`: one headless turn. Text to stdout, activity to stderr. */
import { privateLabel, receiptLine, redactedLabel, reviewLines } from '@harness/client';
import type { RoutePreference } from '@harness/protocol';
import { type CommonFlags, connectInProcess } from '../bootstrap.ts';

export interface RunFlags extends CommonFlags {
  prompt: string;
  route: RoutePreference;
  agent?: string;
  yes: boolean;
  json: boolean;
  /** Remote review of local edits; undefined follows `review.mode`. */
  review?: boolean;
}

const dim = (s: string) => (process.stderr.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

export async function run(flags: RunFlags): Promise<number> {
  const { client } = await connectInProcess(flags, flags.yes ? 'approve' : 'deny', 'harness-run');
  const session = await client.request('session.create', flags.agent ? { agent: flags.agent } : {});

  let pinned = false;
  const finished = new Promise<number>((resolve) => {
    client.on((e) => {
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(e)}\n`);
      } else if (e.type === 'config.updated') {
        process.stderr.write(
          dim(`[${e.org ? `${e.org.name} policy updated` : 'config updated'}]\n`),
        );
      } else if (e.type !== 'log' && e.sessionId === session.id) {
        if (e.type === 'text.delta') process.stdout.write(e.text);
        else if (e.type === 'route.decided')
          process.stderr.write(dim(`[${e.tier} · ${e.model.model} · ${e.reason}]\n`));
        else if (e.type === 'tool.started') process.stderr.write(dim(`\n▸ ${e.name}\n`));
        else if (e.type === 'tool.completed' && e.isError)
          process.stderr.write(dim(`  ✗ ${e.output.split('\n')[0]}\n`));
        if (e.type === 'tool.completed' && e.private && !pinned) {
          pinned = true;
          process.stderr.write(dim(`${privateLabel(e.private)}\n`));
        } else if (e.type === 'review.completed')
          process.stderr.write(
            dim(`${reviewLines({ ...e, kind: 'review', id: e.turnId }).join('\n')}\n`),
          );
        else if (e.type === 'secrets.redacted')
          process.stderr.write(dim(`${redactedLabel(e.kinds, e.model)}\n`));
        else if (e.type === 'subagent.started')
          process.stderr.write(dim(`↳ ${e.agent}: ${e.task}\n`));
        else if (e.type === 'error') process.stderr.write(`error: ${e.message}\n`);
      }
      if (e.type === 'turn.completed' && e.sessionId === session.id) {
        if (!flags.json) process.stdout.write('\n');
        resolve(e.stopReason === 'end_turn' ? 0 : 1);
      }
    });
  });
  await client.request('session.prompt', {
    sessionId: session.id,
    text: flags.prompt,
    route: flags.route,
    ...(flags.review !== undefined ? { review: flags.review } : {}),
  });
  const code = await finished;
  if (!flags.json) {
    const u = await client.request('usage.get', { sessionId: session.id });
    process.stderr.write(dim(`${receiptLine(u)}\n`));
  }
  await client.request('shutdown', {});
  return code;
}
