import type { RoutePreference } from '@harness/protocol';
import { render } from 'ink';
import { type CommonFlags, connectInProcess } from '../bootstrap.ts';
import { App } from './App.tsx';

export async function tui(
  opts: CommonFlags & { route: RoutePreference; agent?: string },
): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write('harness: the terminal UI needs a TTY; use `harness run` for scripts\n');
    return 2;
  }
  const { client, init, agentErrors } = await connectInProcess(opts, 'prompt', 'harness-tui');
  const session = await client.request('session.create', opts.agent ? { agent: opts.agent } : {});
  const app = render(
    <App
      client={client}
      init={init}
      initialSession={session}
      initialRoute={opts.route}
      warnings={agentErrors}
    />,
    { exitOnCtrlC: true },
  );
  await app.waitUntilExit();
  await client.request('shutdown', {}).catch(() => {});
  return 0;
}
