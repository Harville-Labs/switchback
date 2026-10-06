import {
  addInfo,
  addUserPrompt,
  initialView,
  nextMode,
  reduce,
  resolveEscalation,
  resolvePermission,
  type SwitchbackClient,
  type ViewState,
} from '@switchback/client';
import type {
  InitializeResult,
  PermissionMode,
  RoutePreference,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import { Box, Static, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { Header, StatusBar, Working } from './Chrome.tsx';
import { PromptHistory } from './history.ts';
import { PromptInput } from './PromptInput.tsx';
import { EscalationPrompt, PermissionPrompt, permissionKey } from './Prompts.tsx';
import { Item, LiveChild, quietRoutes } from './Rows.tsx';
import { runSlashCommand, type SlashContext } from './slash.ts';

interface Props {
  client: SwitchbackClient;
  init: InitializeResult;
  initialSession: SessionSummary;
  /** Present when resuming: the rebuilt history of `initialSession`. */
  initialView?: ViewState;
  initialRoute: RoutePreference;
  warnings: string[];
}

export function App({
  client,
  init,
  initialSession,
  initialView: resumed,
  initialRoute,
  warnings,
}: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [session, setSession] = useState(initialSession);
  const [view, setView] = useState<ViewState>(() =>
    warnings.reduce(
      (v, w) => addInfo(v, w),
      resumed
        ? addInfo(resumed, `resumed "${initialSession.title || initialSession.id}"`)
        : initialView(initialSession.id),
    ),
  );
  const [listed, setListed] = useState<SessionSummary[]>([]);
  // Items before this index are final and rendered once via <Static>.
  const [committed, setCommitted] = useState(0);
  const [route, setRoute] = useState<RoutePreference>(initialRoute);
  /** Review of local edits; undefined follows `review.mode` in config. */
  const [review, setReview] = useState<boolean | undefined>(undefined);
  const [history] = useState(() => new PromptHistory(init.workspaceRoot));
  const [usage, setUsage] = useState<UsageReport | undefined>();
  /** Modes this session may cycle through; an organization can rule out bypass. */
  const [modes, setModes] = useState<PermissionMode[]>(['default', 'acceptEdits', 'plan']);
  const mode = view.mode ?? session.permissionMode ?? 'default';

  useEffect(() => {
    client.request('permissions.list', { sessionId: session.id }).then(
      (p) => setModes(p.modes),
      () => {},
    );
  }, [client, session.id]);

  const refreshUsage = useCallback(() => {
    client.request('usage.get', {}).then(setUsage, () => {});
  }, [client]);

  useEffect(() => {
    refreshUsage();
    return client.on((event) => {
      setView((v) => reduce(v, event));
      if (event.type === 'turn.completed' && event.sessionId === session.id) refreshUsage();
    });
  }, [client, session.id, refreshUsage]);

  // Commit finished turns so Ink stops re-rendering them.
  useEffect(() => {
    if (!view.running) setCommitted(view.items.length);
  }, [view.running, view.items.length]);

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
    listed,
    setListed,
    writeRaw: (s) => stdout.write(s),
    exit,
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    history.add(raw);
    if (text.startsWith('/')) return runSlashCommand(slash, text);
    if (view.running) return;
    setView((v) => addUserPrompt(v, text));
    const params = {
      sessionId: session.id,
      text,
      route,
      ...(review !== undefined ? { review } : {}),
    };
    client.request('session.prompt', params).catch((err) => {
      setView((v) => addInfo({ ...v, running: false }, `error: ${(err as Error).message}`));
    });
  };

  const permission = view.permissions[0];
  const escalation = view.escalations[0];

  useInput((ch, key) => {
    if (permission) {
      const answer = permissionKey(permission, ch, key.escape);
      if (!answer) return;
      client
        .request('permission.respond', { requestId: permission.requestId, ...answer })
        .catch(() => {});
      setView((v) => resolvePermission(v, permission.requestId, answer.decision));
      return;
    }
    if (escalation) {
      const approve = ch === 'y' ? true : ch === 'n' || key.escape ? false : undefined;
      if (approve === undefined) return;
      client
        .request('escalation.respond', { requestId: escalation.requestId, approve })
        .catch(() => {});
      setView((v) => resolveEscalation(v, escalation.requestId));
      return;
    }
    if (key.tab && key.shift) {
      client
        .request('session.setMode', { sessionId: session.id, mode: nextMode(mode, modes) })
        .catch((err: Error) => setView((v) => addInfo(v, `mode: ${err.message}`)));
      return;
    }
    if (key.escape && view.running)
      client.request('session.cancel', { sessionId: session.id }).catch(() => {});
  });

  const hidden = quietRoutes(view.items);
  const width = Math.max(40, Math.min(120, (stdout.columns ?? 80) - 2));
  const done = view.items.slice(0, committed);
  const live = view.items.slice(committed);

  return (
    <Box flexDirection="column">
      <Static items={[{ kind: 'header' as const, id: 'header' }, ...done]}>
        {(item) =>
          item.kind === 'header' ? (
            <Header
              key="header"
              version={init.engineVersion}
              root={init.workspaceRoot}
              width={width}
            />
          ) : (
            <Item key={item.id} item={item} hidden={hidden.has(item.id)} width={width} final />
          )
        }
      </Static>
      {live.map((item) => (
        <Box key={item.id} flexDirection="column">
          <Item item={item} hidden={hidden.has(item.id)} width={width} />
          {item.kind === 'subagent' && item.status === 'running' && view.children[item.id] ? (
            <LiveChild view={view.children[item.id] as ViewState} depth={1} />
          ) : null}
        </Box>
      ))}

      {permission && (
        <PermissionPrompt
          permission={permission}
          maxLines={Math.max(6, (stdout.rows ?? 30) - 12)}
          width={width}
        />
      )}
      {escalation && !permission && <EscalationPrompt escalation={escalation} />}

      {view.running && !permission && !escalation ? <Working view={view} /> : null}
      <Box borderStyle="round" borderColor={view.running ? 'gray' : 'cyan'} paddingX={1}>
        <PromptInput
          focus={!permission && !escalation}
          busy={view.running}
          history={history.list()}
          root={init.workspaceRoot}
          onSubmit={submit}
          placeholder={
            view.running
              ? 'Type your next message'
              : 'Ask anything · / for commands · @ to mention a file'
          }
        />
      </Box>
      <StatusBar
        session={session}
        route={route}
        review={review}
        view={view}
        usage={usage}
        mode={mode}
      />
    </Box>
  );
}
