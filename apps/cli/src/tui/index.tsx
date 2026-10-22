import { fromTranscript, type ViewState } from '@switchback/client';
import { switchbackPaths } from '@switchback/engine';
import type {
  EffortLevel,
  PermissionMode,
  RoutePreference,
  SessionSummary,
} from '@switchback/protocol';
import { render } from 'ink';
import { CLI_VERSION, type CommonFlags, checksForUpdates, connectShared } from '../bootstrap.ts';
import { newerRelease, runFromSource, updateNotice } from '../update-check.ts';
import { App } from './App.tsx';
import { mouseInput, savedMouse } from './mouse.ts';
import type { Opening } from './SetupPanel.tsx';
import { terminalTitles } from './terminal-title.ts';
import { savedTheme } from './theme.ts';

/** How long launch waits on a release lookup still running once the session is ready. */
const UPDATE_WAIT_MS = 300;

export async function tui(
  opts: CommonFlags & {
    route: RoutePreference;
    agent?: string;
    /** `latest` for --continue, or a session id. */
    resume?: string;
    /** Attach to (or start) the workspace's shared daemon. */
    daemon: boolean;
    permissionMode?: PermissionMode;
    effort?: EffortLevel;
    /** What to open over the prompt first. */
    opening?: Opening;
  },
): Promise<number> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'switchback: the terminal UI needs a TTY; use `switchback run` for scripts\n',
    );
    return 2;
  }
  const update =
    opts.mock || runFromSource(process.execPath) || !checksForUpdates(opts.cwd)
      ? undefined
      : newerRelease({ dataDir: switchbackPaths().dataDir, current: CLI_VERSION, now: new Date() });
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
    ...(opts.effort ? { effort: opts.effort } : {}),
  });
  if (opts.permissionMode && session.permissionMode !== opts.permissionMode)
    await client.request('session.setMode', { sessionId: session.id, mode: opts.permissionMode });
  if (opts.effort && session.effort !== opts.effort)
    session = {
      ...session,
      ...(await client.request('session.setEffort', {
        sessionId: session.id,
        effort: opts.effort,
      })),
    };
  // The lookup runs while the engine starts; one still out by now never holds up the launch.
  const latest = await Promise.race([update, Bun.sleep(UPDATE_WAIT_MS)]);
  if (latest) warnings.push(updateNotice(latest, CLI_VERSION));
  const mouse = mouseInput(process.stdin, process.stdout, savedMouse());
  let open = session;
  const titles = terminalTitles(process.stdout);
  titles.set(session.title);
  const app = render(
    <App
      client={client}
      init={init}
      initialSession={session}
      {...(history ? { initialView: history } : {})}
      initialRoute={opts.route}
      {...(opts.opening ? { opening: opts.opening } : {})}
      warnings={warnings}
      initialTheme={savedTheme()}
      mouse={mouse}
      onSession={(s) => {
        open = s;
        titles.set(s.title);
      }}
    />,
    {
      // Ctrl+C clears the prompt or cancels a turn; quitting takes a second press (App.tsx).
      exitOnCtrlC: false,
      // Full screen, like an editor: the shell's scrollback is back as it was on exit.
      alternateScreen: true,
      stdin: mouse.stdin,
      // Where the terminal supports kitty's keyboard protocol, keys it would
      // otherwise merge arrive distinct: ctrl+tab, shift+enter, ctrl+i vs tab.
      kittyKeyboard: { mode: 'auto' },
    },
  );
  try {
    await app.waitUntilExit();
  } finally {
    mouse.dispose();
    titles.restore();
  }
  await client.request('shutdown', {}).catch(() => {});
  // The full-screen view is gone; say how to get back to it.
  process.stdout.write(
    `Session ${open.title ? `"${open.title}" ` : ''}saved · resume with switchback --resume ${open.id}\n`,
  );
  return 0;
}
