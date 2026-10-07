/**
 * The terminal UI, full screen: the transcript fills the window above a dock
 * (prompts, the working line, the input, the status bar) that stays put at
 * the bottom. The transcript scrolls with Page Up/Down and the mouse wheel.
 */
import {
  AttentionTracker,
  addInfo,
  addUserPrompt,
  customCommands,
  initialView,
  isCustomCommand,
  nextMode,
  reduce,
  resolveEscalation,
  resolvePermission,
  type SlashCommand,
  type SwitchbackClient,
  type ViewState,
} from '@switchback/client';
import type {
  CheckpointInfo,
  InitializeResult,
  PermissionMode,
  RoutePreference,
  SessionRewindParams,
  SessionRoles,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import { Box, Text, useApp, useBoxMetrics, useInput, useStdout, useWindowSize } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Header, Queue, StatusBar, Todos, Working } from './Chrome.tsx';
import { PromptHistory } from './history.ts';
import type { MouseInput } from './mouse.ts';
import { terminalNotification } from './notify.ts';
import { type PastedImage, PromptInput } from './PromptInput.tsx';
import { EscalationPrompt, type PermissionAnswer, PermissionPrompt } from './Prompts.tsx';
import { RewindPicker } from './RewindPicker.tsx';
import { SessionPicker } from './SessionPicker.tsx';
import { escalateNow, resume, runSlashCommand, type SlashContext } from './slash.ts';
import { useScroll, useTranscriptLines, Viewport } from './Transcript.tsx';
import { saveTheme, THEMES, ThemeContext, type ThemeName } from './theme.ts';

interface Props {
  client: SwitchbackClient;
  init: InitializeResult;
  initialSession: SessionSummary;
  /** Present when resuming: the rebuilt history of `initialSession`. */
  initialView?: ViewState;
  initialRoute: RoutePreference;
  warnings: string[];
  /** Open the session picker first (`switchback --resume`). */
  pickSession?: boolean;
  initialTheme?: ThemeName;
  /** Wheel events, when the terminal reports them. */
  mouse?: MouseInput;
  /** Told which session was open when the app quits, for the resume hint. */
  onSession?: (session: SessionSummary) => void;
}

/** A second Ctrl+C within this long quits; one press alone never does. */
const EXIT_WINDOW_MS = 2_000;

export function App({
  client,
  init,
  initialSession,
  initialView: resumed,
  initialRoute,
  warnings,
  pickSession = false,
  initialTheme = 'dark',
  mouse,
  onSession,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useWindowSize();
  // A terminal that doesn't say how big it is (tests, some multiplexers) gets the classic size.
  const columns = size.columns || 80;
  const rows = size.rows || 24;
  const [session, setSession] = useState(initialSession);
  useEffect(() => onSession?.(session), [session, onSession]);
  const [view, setView] = useState<ViewState>(() =>
    warnings.reduce(
      (v, w) => addInfo(v, w),
      resumed
        ? addInfo(resumed, `resumed "${initialSession.title || initialSession.id}"`)
        : initialView(initialSession.id),
    ),
  );
  const [listed, setListed] = useState<SessionSummary[]>([]);
  // Items before this index are finished: their Markdown is rendered and cached.
  const [committed, setCommitted] = useState(0);
  const [route, setRoute] = useState<RoutePreference>(initialRoute);
  /** Review of local edits; undefined follows `review.mode` in config. */
  const [review, setReview] = useState<boolean | undefined>(undefined);
  const [history] = useState(() => new PromptHistory(init.workspaceRoot));
  const [usage, setUsage] = useState<UsageReport | undefined>();
  /** Modes this session may cycle through; an organization can rule out bypass. */
  const [modes, setModes] = useState<PermissionMode[]>(['default', 'acceptEdits', 'plan']);
  const mode = view.mode ?? session.permissionMode ?? 'default';
  const [roles, setRoles] = useState<SessionRoles | undefined>();
  /** Saved sessions while the picker is open. */
  const [picking, setPicking] = useState<SessionSummary[] | undefined>();
  /** Checkpoints while the rewind picker is open. */
  const [rewinding, setRewinding] = useState<CheckpointInfo[] | undefined>();
  /** When Ctrl+C was pressed on an empty, idle prompt; a second press soon after quits. */
  const [exitArmedAt, setExitArmedAt] = useState<number | undefined>();
  /** ctrl+o: reasoning, command output, and diffs in full. */
  const [expanded, setExpanded] = useState(false);
  const [themeName, setThemeName] = useState<ThemeName>(initialTheme);
  const theme = THEMES[themeName];
  /** Custom commands from `.switchback/commands/` and yours, for the menu and /help. */
  const [custom, setCustom] = useState<SlashCommand[]>([]);
  /** MCP resources, as `server:uri`, for @ completion. */
  const [resources, setResources] = useState<string[]>([]);
  useEffect(() => {
    client.request('mcp.list', {}).then(
      ({ servers }) =>
        setResources(servers.flatMap((s) => (s.resources ?? []).map((r) => `${s.name}:${r.uri}`))),
      () => {},
    );
  }, [client]);

  useEffect(() => {
    if (exitArmedAt === undefined) return;
    const timer = setTimeout(() => setExitArmedAt(undefined), EXIT_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [exitArmedAt]);

  const openPicker = async () => {
    const sessions = await client.request('session.list', {}).catch(() => []);
    setPicking(sessions);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on the first render
  useEffect(() => {
    if (pickSession) void openPicker();
  }, []);

  useEffect(() => {
    client.request('permissions.list', { sessionId: session.id }).then(
      (p) => setModes(p.modes),
      () => {},
    );
    client.request('session.roles', { sessionId: session.id }).then(setRoles, () => {});
  }, [client, session.id]);

  const refreshUsage = useCallback(() => {
    client.request('usage.get', {}).then(setUsage, () => {});
    // Command files can change between turns; the engine rescans them on each list.
    client.request('commands.list', {}).then(
      (c) => setCustom(customCommands(c)),
      () => {},
    );
  }, [client]);

  // One tracker for the app's life: it remembers when turns started.
  const [attention] = useState(() => new AttentionTracker(init.notifications));
  useEffect(() => {
    refreshUsage();
    return client.on((event) => {
      setView((v) => reduce(v, event));
      const a = attention.observe(event);
      if (a) stdout.write(terminalNotification(a.message, init.notifications?.mode ?? 'system'));
      if (event.type === 'turn.completed' && event.sessionId === session.id) refreshUsage();
    });
  }, [client, session.id, refreshUsage, attention, init.notifications, stdout]);

  // A finished turn's items are final: render their Markdown once.
  useEffect(() => {
    if (!view.running) setCommitted(view.items.length);
  }, [view.running, view.items.length]);

  const width = Math.max(40, columns - 2);
  const viewport = useRef(null);
  const { height } = useBoxMetrics(viewport);
  const lines = useTranscriptLines({
    view,
    committed,
    width,
    theme,
    expanded,
    header: <Header init={init} roles={view.roles ?? roles} mode={mode} width={width} />,
    headerKey: `${mode}|${JSON.stringify(view.roles ?? roles ?? null)}`,
  });
  const scroll = useScroll(lines.length, height);
  useEffect(() => mouse?.onWheel((d) => scroll.by(d)), [mouse, scroll.by]);

  const slash: SlashContext = {
    client,
    init,
    session,
    view,
    setView,
    setSession,
    setRoute,
    setReview,
    setUsage,
    custom,
    listed,
    setListed,
    writeRaw: (s) => stdout.write(s),
    exit,
    openPicker,
    openRewind: async () => {
      const checkpoints = await client
        .request('session.checkpoints', { sessionId: session.id })
        .catch(() => []);
      setRewinding(checkpoints);
    },
    theme: themeName,
    setTheme: (name) => {
      setThemeName(name);
      saveTheme(name);
    },
  };

  const rewind = async (turnId: string, restore: SessionRewindParams['restore']) => {
    setRewinding(undefined);
    try {
      const r = await client.request('session.rewind', { sessionId: session.id, turnId, restore });
      const files = r.files.length ? `Put back ${r.files.join(', ')}.` : 'No files to put back.';
      setView((v) => addInfo(v, restore === 'conversation' ? 'Rewound the conversation.' : files));
      if (r.session) await resume(slash, r.session.id);
    } catch (err) {
      setView((v) => addInfo(v, `rewind: ${(err as Error).message}`));
    }
  };

  /** Ctrl+C with nothing typed: cancel the turn, or quit on a second press. */
  const interrupt = () => {
    if (view.running) {
      client.request('session.cancel', { sessionId: session.id }).catch(() => {});
      return;
    }
    if (exitArmedAt !== undefined && Date.now() - exitArmedAt < EXIT_WINDOW_MS) return exit();
    setExitArmedAt(Date.now());
  };

  const submit = async (raw: string, images: PastedImage[] = []) => {
    const text = raw.trim();
    if (!text) return;
    history.add(raw);
    scroll.toEnd();
    if (text.startsWith('/') && !isCustomCommand(text, custom)) return runSlashCommand(slash, text);
    send(text, view.running ? 'queue' : undefined, images);
  };

  /**
   * Send a prompt. Idle, it starts a turn; during one, `queue` hands it to the
   * model at the next step (it shows once delivered) and `interrupt` starts it now.
   */
  const send = (text: string, delivery?: 'queue' | 'interrupt', images: PastedImage[] = []) => {
    if (delivery !== 'queue')
      setView((v) =>
        addUserPrompt(
          v,
          text,
          images.map(({ name }) => ({ name })),
        ),
      );
    const params = {
      sessionId: session.id,
      text,
      ...(images.length
        ? { attachments: images.map((i) => ({ kind: 'image' as const, ...i })) }
        : {}),
      route,
      ...(review !== undefined ? { review } : {}),
      ...(delivery ? { delivery } : {}),
    };
    client.request('session.prompt', params).catch((err) => {
      setView((v) => addInfo({ ...v, running: false }, `error: ${(err as Error).message}`));
    });
  };

  /** The last queued prompt, withdrawn so it can be edited and sent again. */
  const recall = (): string | undefined => {
    const last = view.queue?.at(-1);
    if (!last) return undefined;
    client.request('session.dequeue', { sessionId: session.id, id: last.id }).catch(() => {});
    return last.text;
  };

  const permission = view.permissions[0];
  const escalation = view.escalations[0];

  const answerPermission = (answer: PermissionAnswer) => {
    if (!permission) return;
    client
      .request('permission.respond', { requestId: permission.requestId, ...answer })
      .catch(() => {});
    setView((v) => resolvePermission(v, permission.requestId, answer.decision));
  };
  const answerEscalation = (approve: boolean) => {
    if (!escalation) return;
    client
      .request('escalation.respond', { requestId: escalation.requestId, approve })
      .catch(() => {});
    setView((v) => resolveEscalation(v, escalation.requestId));
  };

  useInput((ch, key) => {
    // Scrolling works whatever has focus.
    if (key.pageUp) return scroll.page(-1);
    if (key.pageDown) return scroll.page(1);
    // The pickers, the prompts, and the input handle their own keys, Ctrl+C included.
    if (picking || rewinding || permission || escalation) return;
    if (key.ctrl && ch === 'o') return setExpanded((v) => !v);
    if (key.meta && key.upArrow) return void escalateNow(slash);
    if (key.tab && key.shift) {
      client
        .request('session.setMode', { sessionId: session.id, mode: nextMode(mode, modes) })
        .catch((err: Error) => setView((v) => addInfo(v, `mode: ${err.message}`)));
    }
  });

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" height={rows} width={columns}>
        <Box ref={viewport} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          <Viewport lines={lines} height={height} scroll={scroll.scroll} unseen={scroll.unseen} />
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {view.todos?.some((t) => t.status !== 'done') ? <Todos todos={view.todos} /> : null}
          {view.queue?.length ? <Queue queue={view.queue} /> : null}
          {permission ? (
            <PermissionPrompt
              key={permission.requestId}
              permission={permission}
              maxLines={Math.max(6, Math.floor(rows / 2) - 8)}
              width={width}
              onAnswer={answerPermission}
            />
          ) : null}
          {escalation && !permission ? (
            <EscalationPrompt
              key={escalation.requestId}
              escalation={escalation}
              onAnswer={answerEscalation}
            />
          ) : null}
          {picking ? (
            <SessionPicker
              sessions={picking}
              current={session.id}
              onCancel={() => setPicking(undefined)}
              onPick={(id) => {
                setPicking(undefined);
                void resume(slash, id);
              }}
            />
          ) : null}
          {rewinding ? (
            <RewindPicker
              checkpoints={rewinding}
              onCancel={() => setRewinding(undefined)}
              onRewind={(turnId, restore) => void rewind(turnId, restore)}
            />
          ) : null}
          {view.running && !permission && !escalation ? <Working view={view} /> : null}
          <Box borderStyle="round" borderColor={view.running ? 'gray' : theme.brand} paddingX={1}>
            <PromptInput
              focus={!permission && !escalation && !picking && !rewinding}
              custom={custom}
              resources={resources}
              onInterrupt={interrupt}
              onSubmitNow={(text, images) => send(text, 'interrupt', images)}
              onNoImage={() =>
                setView((v) =>
                  addInfo(
                    v,
                    'No image on the clipboard. To attach an image file, drag it in or mention it with @.',
                  ),
                )
              }
              onCancel={() => {
                if (view.running)
                  client.request('session.cancel', { sessionId: session.id }).catch(() => {});
              }}
              recall={recall}
              busy={view.running}
              history={history.list()}
              root={init.workspaceRoot}
              onSubmit={submit}
              placeholder={
                view.running
                  ? 'Queue a message (enter) · send now (esc)'
                  : 'Ask anything · / for commands · @ to mention a file'
              }
            />
          </Box>
          {exitArmedAt !== undefined ? (
            <Text color={theme.warning} dimColor>
              {'  '}Press Ctrl+C again to exit
            </Text>
          ) : null}
          <StatusBar
            session={session}
            route={route}
            review={review}
            view={view}
            usage={usage}
            mode={mode}
          />
        </Box>
      </Box>
    </ThemeContext.Provider>
  );
}
