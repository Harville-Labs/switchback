import { fromTranscript, type ViewState } from '@switchback/client';
import type { PermissionMode, RoutePreference, SessionSummary } from '@switchback/protocol';
import { render } from 'ink';
import { type CommonFlags, connectShared } from '../bootstrap.ts';
import { App } from './App.tsx';
import { mouseInput } from './mouse.ts';
import { savedTheme } from './theme.ts';

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
  const mouse = mouseInput();
  let open = session;
  const app = render(
    <App
      client={client}
      init={init}
      initialSession={session}
      {...(history ? { initialView: history } : {})}
      initialRoute={opts.route}
      pickSession={opts.pickSession ?? false}
      warnings={warnings}
      initialTheme={savedTheme()}
      mouse={mouse}
      onSession={(s) => {
        open = s;
      }}
    />,
    {
      // Ctrl+C clears the prompt or cancels a turn; quitting takes a second press (App.tsx).
      exitOnCtrlC: false,
      // Full screen, like an editor: the shell's scrollback is back as it was on exit.
      alternateScreen: true,
      stdin: mouse.stdin,
    },
  );
  try {
    await app.waitUntilExit();
  } finally {
    mouse.dispose();
  }
  await client.request('shutdown', {}).catch(() => {});
  // The full-screen view is gone; say how to get back to it.
  process.stdout.write(
    `Session ${open.title ? `"${open.title}" ` : ''}saved · resume with switchback --resume ${open.id}\n`,
  );
  return 0;
}
