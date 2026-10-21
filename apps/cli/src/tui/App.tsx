/**
 * The terminal UI, full screen: the transcript fills the window above a dock
 * (prompts, the working line, the input, the status bar) that stays put at
 * the bottom. The transcript scrolls with Page Up/Down and the mouse wheel.
 */
import {
  activeTab,
  addInfo,
  addUserPrompt,
  type ChosenRole,
  closeTab,
  dashboardRows,
  fromTranscript,
  initialTabs,
  initialView,
  isCustomCommand,
  modelChoices,
  nextMode,
  openTab,
  replaceActive,
  resolveEscalation,
  resolvePermission,
  type SwitchbackClient,
  switchTab,
  type TabsState,
  updateActiveView,
  updateView,
  type ViewState,
} from '@switchback/client';
import type {
  CheckpointInfo,
  InitializeResult,
  RoutePreference,
  SessionRewindParams,
  SessionSummary,
} from '@switchback/protocol';
import { Box, Text, useApp, useBoxMetrics, useStdout, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header, Queue, StatusBar, SubagentHeader, Todos, Working } from './Chrome.tsx';
import { useEngineFeeds } from './feeds.ts';
import { useSubagentFocus } from './focus.ts';
import { PromptHistory } from './history.ts';
import { useAppKeys } from './keys.ts';
import { ModelPicker } from './ModelPicker.tsx';
import type { MouseInput } from './mouse.ts';
import { type PastedImage, PromptInput } from './PromptInput.tsx';
import { EscalationPrompt, type PermissionAnswer, PermissionPrompt } from './Prompts.tsx';
import { RewindPicker } from './RewindPicker.tsx';
import { SessionPicker } from './SessionPicker.tsx';
import { useSetup } from './SetupPanel.tsx';
import { cycleModel, pickModel, resume, runSlashCommand, type SlashContext } from './slash.ts';
import { Dashboard, TabBar, useTabBar } from './Tabs.tsx';
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
  init: launched,
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
  // Every open session is a tab; the one in front is `session` and `view`.
  const [tabs, setTabs] = useState<TabsState>(() =>
    initialTabs(
      initialSession,
      warnings.reduce(
        (v, w) => addInfo(v, w),
        resumed
          ? addInfo(resumed, `resumed "${initialSession.title || initialSession.id}"`)
          : initialView(initialSession.id),
      ),
    ),
  );
  const { session, view } = activeTab(tabs);
  useEffect(() => onSession?.(session), [session, onSession]);
  const setView = useCallback(
    (update: (v: ViewState) => ViewState) => setTabs((t) => updateActiveView(t, update)),
    [],
  );
  // The view follows with setView, so a replaced tab keeps its items until then.
  const setSession = useCallback(
    (s: SessionSummary) => setTabs((t) => replaceActive(t, s, (v) => v)),
    [],
  );
  const dashRows = useMemo(() => dashboardRows(tabs), [tabs]);
  const spans = useTabBar(dashRows, columns, mouse, setTabs);
  const { focused, row: focusedRow, shown, next, unfocus } = useSubagentFocus(view, session.id);
  const [listed, setListed] = useState<SessionSummary[]>([]);
  // Items before this index are finished: their Markdown is rendered and cached.
  const [committed, setCommitted] = useState(0);
  const [route, setRoute] = useState<RoutePreference>(initialRoute);
  /** Review of local edits; undefined follows `review.mode` in config. */
  const [review, setReview] = useState<boolean | undefined>(undefined);
  const [history] = useState(() => new PromptHistory(launched.workspaceRoot));
  const { usage, setUsage, modes, roles, custom, resources, models, refreshSessions } =
    useEngineFeeds(client, launched, session.id, tabs, setTabs);
  const init = useMemo(() => ({ ...launched, models }), [launched, models]);
  const mode = view.mode ?? session.permissionMode ?? 'default';
  const sessionRoles = view.roles ?? roles;
  /** Saved sessions while the picker is open. */
  const [picking, setPicking] = useState<SessionSummary[] | undefined>();
  /** Checkpoints while the rewind picker is open. */
  const [rewinding, setRewinding] = useState<CheckpointInfo[] | undefined>();
  /** The role whose model is being picked (`/current`, `/model`). */
  const [choosingModel, setChoosingModel] = useState<ChosenRole | undefined>();
  /** The sessions dashboard (ctrl+t, `/tabs`) is open. */
  const [dashboard, setDashboard] = useState(false);
  /** When Ctrl+C was pressed on an empty, idle prompt; a second press soon after quits. */
  const [exitArmedAt, setExitArmedAt] = useState<number | undefined>();
  /** ctrl+o: reasoning, command output, and diffs in full. */
  const [expanded, setExpanded] = useState(false);
  const [themeName, setThemeName] = useState<ThemeName>(initialTheme);
  const setup = useSetup(client, (text) => setView((v) => addInfo(v, text)));
  const modal = Boolean(picking || rewinding || choosingModel || dashboard || setup.active);
  const theme = THEMES[themeName];
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

  // A finished turn's items are final: render their Markdown once. Another
  // tab in front is final up to its last prompt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on switching tabs only
  useEffect(() => {
    const last = view.items.findLastIndex((i) => i.kind === 'user');
    setCommitted(view.running ? Math.max(0, last) : view.items.length);
  }, [session.id]);
  useEffect(() => {
    if (!view.running) setCommitted(view.items.length);
  }, [view.running, view.items.length]);

  const width = Math.max(40, columns - 2);
  const viewport = useRef(null);
  const { height } = useBoxMetrics(viewport);
  const lines = useTranscriptLines({
    view: shown,
    // A subagent's items are final up to its task while it runs.
    committed: shown === view ? committed : shown.running ? 0 : shown.items.length,
    width,
    theme,
    expanded,
    header: focusedRow ? (
      <SubagentHeader row={focusedRow} />
    ) : (
      <Header init={init} roles={sessionRoles} mode={mode} width={width} />
    ),
    headerKey: `${focused}|${mode}|${JSON.stringify(sessionRoles ?? null)}`,
  });
  const scroll = useScroll(lines.length, height);
  useEffect(() => mouse?.onWheel((d) => scroll.by(d)), [mouse, scroll.by]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a tab or subagent comes forward at its end
  useEffect(() => scroll.toEnd(), [session.id, focused]);

  /** A new session in a new tab, in front. */
  const newTab = async (agent?: string) => {
    try {
      const s = await client.request('session.create', agent ? { agent } : {});
      setTabs((t) => openTab(t, s));
    } catch (err) {
      setView((v) => addInfo(v, (err as Error).message));
    }
  };
  /** Bring a session forward: its tab, or a new tab for one open in another window. */
  const showSession = async (sessionId: string) => {
    if (tabs.tabs.some((t) => t.session.id === sessionId))
      return setTabs((t) => switchTab(t, sessionId));
    try {
      const { session: s, messages } = await client.request('session.get', { sessionId });
      setTabs((t) => openTab(t, s, fromTranscript(s, messages)));
    } catch (err) {
      setView((v) => addInfo(v, (err as Error).message));
    }
  };

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
    openModelPicker: setChoosingModel,
    openSetup: setup.start,
    focusedSubagent: focusedRow?.agent,
    tabs,
    openDashboard: () => {
      refreshSessions();
      setDashboard(true);
    },
    newTab,
    showSession,
    closeTab: (sessionId) => setTabs((t) => closeTab(t, sessionId)),
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
    // Prompts go to the session, so it comes back into view.
    unfocus();
    send(text, view.running ? 'queue' : undefined, images);
  };

  /**
   * Send a prompt. Idle, it starts a turn; during one, `queue` hands it to the
   * model at the next step (it shows once delivered) and `interrupt` starts it now.
   */
  const send = (text: string, delivery?: 'queue' | 'interrupt', images: PastedImage[] = []) => {
    // Errors go to the tab that sent the prompt, wherever the user is by then.
    const to = session.id;
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
      setTabs((t) =>
        updateView(t, to, (v) =>
          addInfo({ ...v, running: false }, `error: ${(err as Error).message}`),
        ),
      );
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
  const currentAlias = sessionRoles?.current?.[0];
  const currentModel = init.models.find((m) => m.alias === currentAlias);
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

  useAppKeys({
    tabs,
    setTabs,
    page: scroll.page,
    modal,
    prompting: Boolean(permission || escalation),
    openDashboard: slash.openDashboard,
    toggleExpanded: () => setExpanded((v) => !v),
    nextSubagent: next,
    showSession: unfocus,
    nextMode: () =>
      client
        .request('session.setMode', { sessionId: session.id, mode: nextMode(mode, modes) })
        .catch((err: Error) => setView((v) => addInfo(v, `mode: ${err.message}`))),
  });

  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" height={rows} width={columns}>
        <Box flexShrink={0}>
          <TabBar spans={spans} />
        </Box>
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
          {choosingModel ? (
            <ModelPicker
              role={choosingModel}
              choices={modelChoices(init.models, sessionRoles, choosingModel)}
              onCancel={() => setChoosingModel(undefined)}
              onPick={(alias) => {
                setChoosingModel(undefined);
                void pickModel(slash, sessionRoles, choosingModel, alias);
              }}
            />
          ) : null}
          {setup.panel}
          {dashboard ? (
            <Dashboard
              rows={dashRows}
              onCancel={() => setDashboard(false)}
              onNew={() => {
                setDashboard(false);
                void newTab();
              }}
              onClose={(sessionId) => setTabs((t) => closeTab(t, sessionId))}
              onOpen={(sessionId) => {
                setDashboard(false);
                void showSession(sessionId);
              }}
            />
          ) : null}
          {view.running && !permission && !escalation ? <Working view={view} /> : null}
          <Box borderStyle="round" borderColor={view.running ? 'gray' : theme.brand} paddingX={1}>
            <PromptInput
              focus={!permission && !escalation && !modal}
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
              onTab={() => void cycleModel(slash, sessionRoles)}
              onCloseTab={() => setTabs((t) => closeTab(t, session.id))}
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
            viewing={focusedRow?.agent}
            current={
              currentModel ? { model: currentModel.ref.model, tier: currentModel.tier } : undefined
            }
          />
        </Box>
      </Box>
    </ThemeContext.Provider>
  );
}
