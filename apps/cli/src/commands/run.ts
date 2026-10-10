/**
 * `switchback run "<prompt>"`: one headless turn, for scripts and CI.
 *
 * Exit codes: 0 done; 1 the turn failed (an error, a refusal, the step
 * limit); 3 it finished, but a tool call was refused (by the permission
 * policy, a hook, or no `--yes`). Usage errors exit 2 before anything runs.
 */
import { receiptLine } from '@switchback/client';
import {
  isSessionEvent,
  type PermissionMode,
  type RoutePreference,
  type StopReason,
} from '@switchback/protocol';
import { type CommonFlags, connectInProcess } from '../bootstrap.ts';
import { eventPrinter, type RunOutput } from './run-output.ts';

export interface RunFlags extends CommonFlags {
  prompt: string;
  route: RoutePreference;
  agent?: string;
  yes: boolean;
  output: RunOutput;
  /** Review of local edits; undefined follows `review.mode`. */
  review?: boolean;
  permissionMode?: PermissionMode;
  /** Added to this run's system prompt. */
  instructions?: string;
  /** Continue a saved session instead of starting one: an ID, or `latest`. */
  resume?: string;
}

export const EXIT = { done: 0, failed: 1, usage: 2, denied: 3 } as const;

export async function run(flags: RunFlags): Promise<number> {
  const { client } = await connectInProcess(
    flags,
    flags.yes ? 'approve' : 'deny',
    'switchback-run',
  );
  const sessionId = await session(client, flags);
  if (!sessionId) {
    process.stderr.write('switchback run: no saved session in this workspace to continue\n');
    await client.request('shutdown', {});
    return EXIT.usage;
  }

  const print = eventPrinter(flags.output, sessionId);
  let denied = false;
  let answer = '';
  const finished = new Promise<StopReason>((resolve) => {
    client.on((e) => {
      print(e);
      if (!isSessionEvent(e) || e.sessionId !== sessionId) return;
      if (e.type === 'text.delta') answer += e.text;
      if (e.type === 'turn.started') answer = '';
      if (e.type === 'tool.completed' && e.denied) denied = true;
      if (e.type === 'turn.completed') resolve(e.stopReason);
    });
  });
  await client.request('session.prompt', {
    sessionId,
    text: flags.prompt,
    route: flags.route,
    ...(flags.review !== undefined ? { review: flags.review } : {}),
  });
  const stopReason = await finished;
  const code = stopReason !== 'end_turn' ? EXIT.failed : denied ? EXIT.denied : EXIT.done;
  const usage = await client.request('usage.get', { sessionId });
  if (flags.output === 'text') process.stdout.write('\n');
  if (flags.output === 'text') process.stderr.write(`${receiptLine(usage)}\n`);
  if (flags.output === 'json')
    process.stdout.write(
      `${JSON.stringify({
        sessionId,
        result: answer,
        stopReason,
        denied,
        exitCode: code,
        costUsd: usage.byTier.remote.costUsd,
        savingsUsd: usage.estimatedSavingsUsd,
        usage: usage.byTier,
      })}\n`,
    );
  await client.request('shutdown', {});
  return code;
}

/** The session the prompt goes to: a saved one to continue, or a new one. */
async function session(
  client: Awaited<ReturnType<typeof connectInProcess>>['client'],
  flags: RunFlags,
): Promise<string | undefined> {
  if (flags.resume) {
    const id =
      flags.resume === 'latest' ? (await client.request('session.list', {}))[0]?.id : flags.resume;
    if (id) await client.request('session.get', { sessionId: id });
    return id;
  }
  const s = await client.request('session.create', {
    ...(flags.agent ? { agent: flags.agent } : {}),
    ...(flags.permissionMode ? { permissionMode: flags.permissionMode } : {}),
    ...(flags.instructions ? { instructions: flags.instructions } : {}),
  });
  return s.id;
}
