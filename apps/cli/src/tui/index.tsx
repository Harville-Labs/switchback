import { fromTranscript, type ViewState } from '@switchback/client';
import type { PermissionMode, RoutePreference, SessionSummary } from '@switchback/protocol';
import { render } from 'ink';
import { type CommonFlags, connectShared } from '../bootstrap.ts';
import { App } from './App.tsx';

export async function tui(
  opts: CommonFlags & {
    route: RoutePreference;
    agent?: string;
    /** `latest` for --continue, or a session id. */
    resume?: string;
    /** Attach to (or start) the workspace's shared daemon. */
    daemon: boolean;
    permissionMode?: PermissionMode;
    /** Open the session picker (`--resume`). */
    pickSession?: boolean;
  },
): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'switchback: the terminal UI needs a TTY; use `switchback run` for scripts\n',
    );
    return 2;
  }
  const { client, init, warnings } = await connectShared(opts, 'switchback-tui');
  let session: SessionSummary | undefined;
  let history: ViewState | undefined;
  if (opts.resume) {
    const id =
      opts.resume === 'latest' ? (await client.request('session.list', {}))[0]?.id : opts.resume;
    if (id) {
      const got = await client.request('session.get', { sessionId: id });
      session = got.session;
      history = fromTranscript(got.session, got.messages);
    } else {
      process.stderr.write('switchback: no saved session in this workspace; starting a new one\n');
    }
  }
  session ??= await client.request('session.create', {
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  });
  if (opts.permissionMode && session.permissionMode !== opts.permissionMode)
    await client.request('session.setMode', { sessionId: session.id, mode: opts.permissionMode });
  const app = render(
    <App
      client={client}
      init={init}
      initialSession={session}
      {...(history ? { initialView: history } : {})}
      initialRoute={opts.route}
      pickSession={opts.pickSession ?? false}
      warnings={warnings}
    />,
    // Ctrl+C clears the prompt or cancels a turn; quitting takes a second press (App.tsx).
    { exitOnCtrlC: false },
  );
  await app.waitUntilExit();
  await client.request('shutdown', {}).catch(() => {});
  return 0;
}
