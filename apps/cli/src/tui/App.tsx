import {
  addInfo,
  addUserPrompt,
  childView,
  describeSession,
  estimateLabel,
  formatMcpServers,
  formatReceipt,
  formatUsage,
  fromTranscript,
  type HarnessClient,
  initialView,
  reduce,
  resolveEscalation,
  resolvePermission,
  reviewLines,
  subagentList,
  toolLabel,
  type ViewItem,
  type ViewState,
} from '@harness/client';
import type {
  InitializeResult,
  RoutePreference,
  SessionSummary,
  UsageReport,
} from '@harness/protocol';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { copyText, pickCopy } from './clipboard.ts';
import { PromptHistory } from './history.ts';
import { renderMarkdown } from './markdown.ts';
import { PromptInput } from './PromptInput.tsx';

interface Props {
  client: HarnessClient;
  init: InitializeResult;
  initialSession: SessionSummary;
  /** Present when resuming: the rebuilt history of `initialSession`. */
  initialView?: ViewState;
  initialRoute: RoutePreference;
  warnings: string[];
}

const HELP = `Commands
  /local  /remote  /auto   route the next prompts
  /agent <name>            start a new session with an agent
  /agents                  list agents
  /new                     start a new session
  /sessions                list saved sessions in this workspace
  /resume <n|id>           switch to a saved session
  /subagents               list this session's subagents as a tree
  /subagent <n>            show what a subagent did: routes, tools, report
  /usage [rule|agent|model] this week's spend, savings, and why
  /receipt                 this session's cost vs. running it all-remote
  /copy [n]                copy the last reply, or its nth code block, to the clipboard
  /review on|off|default   remote review of local edits (default: review.mode)
  /mcp                     MCP servers and their tools
  /compact                 summarize earlier messages now (also automatic)
  /exit                    quit
Input: @ mentions a file (its contents are attached); paste freely: big pastes
       become a chip, dragged-in files become @ mentions; ↑/↓ browse history;
       option/alt+enter, ctrl+j, or a trailing \\ adds a newline.
Keys: esc cancels the running turn; y/a/n answer permission prompts.`;

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
  /** Remote review of local edits; undefined follows `review.mode` in config. */
  const [review, setReview] = useState<boolean | undefined>(undefined);
  const [history] = useState(() => new PromptHistory(init.workspaceRoot));
  const [usage, setUsage] = useState<UsageReport | undefined>();

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

  const newSession = async (agent?: string) => {
    try {
      const s = await client.request('session.create', agent ? { agent } : {});
      setSession(s);
      setView((v) =>
        addInfo({ ...initialView(s.id), items: v.items }, `new session · agent ${s.agent}`),
      );
    } catch (err) {
      setView((v) => addInfo(v, (err as Error).message));
    }
  };

  const resume = async (which: string | undefined) => {
    const target = which && /^\d+$/.test(which) ? listed[Number(which) - 1]?.id : which;
    if (!target) {
      setView((v) => addInfo(v, 'usage: /resume <number from /sessions | session id>'));
      return;
    }
    if (target === session.id) {
      setView((v) => addInfo(v, 'already in that session'));
      return;
    }
    try {
      const { session: s, messages } = await client.request('session.get', { sessionId: target });
      const history = fromTranscript(s, messages);
      setSession(s);
      setView((v) => ({
        ...history,
        items: [
          ...v.items,
          {
            kind: 'info',
            id: `resume-${s.id}-${v.items.length}`,
            text: `── resumed "${s.title || s.id}" ──`,
          },
          ...history.items,
        ],
      }));
    } catch (err) {
      setView((v) => addInfo(v, (err as Error).message));
    }
  };

  const listSessions = async () => {
    const all = await client.request('session.list', {});
    setListed(all);
    const text = all.length
      ? all
          .slice(0, 20)
          .map(
            (x, i) =>
              `${String(i + 1).padStart(2)}. ${x.id === session.id ? '* ' : ''}${x.title || '(untitled)'}  ${x.agent} · ${ago(x.updatedAt)} · $${x.costUsd.toFixed(3)}`,
          )
          .join('\n')
          .concat('\n/resume <number> to switch')
      : 'no saved sessions in this workspace yet';
    setView((v) => addInfo(v, text));
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    history.add(raw);
    if (text.startsWith('/')) {
      const [cmd, ...args] = text.slice(1).split(/\s+/);
      switch (cmd) {
        case 'local':
        case 'remote':
        case 'auto':
          setRoute(cmd);
          setView((v) => addInfo(v, `routing: ${cmd}`));
          return;
        case 'review': {
          const next = args[0] === 'on' ? true : args[0] === 'off' ? false : undefined;
          if (args[0] && args[0] !== 'default' && next === undefined) {
            setView((v) => addInfo(v, 'usage: /review on|off|default'));
            return;
          }
          setReview(next);
          setView((v) =>
            addInfo(
              v,
              next === undefined
                ? 'review: following review.mode in config'
                : next
                  ? 'review: on. After a local model edits files, a remote model reviews the diff and the local model fixes what it finds.'
                  : 'review: off',
            ),
          );
          return;
        }
        case 'agent':
          return newSession(args[0]);
        case 'agents': {
          // Asked each time, so agents created meanwhile (harness agents new) show up.
          const agents = await client.request('agents.list', {}).catch(() => init.agents);
          setView((v) =>
            addInfo(
              v,
              agents
                .map(
                  (a) =>
                    `${a.name} [${a.source}${a.route !== 'auto' ? `, ${a.route}` : ''}]: ${a.description}`,
                )
                .join('\n'),
            ),
          );
          return;
        }
        case 'new':
          return newSession();
        case 'sessions':
          return listSessions();
        case 'resume':
          return resume(args[0]);
        case 'usage': {
          // `/usage` is the weekly picture: where the money went and why.
          const u = await client.request('usage.get', { period: 'week' });
          const by = (['rule', 'agent', 'model'] as const).find((b) => b === args[0]) ?? 'rule';
          setView((v) => addInfo(v, formatUsage(u, by)));
          client.request('usage.get', {}).then(setUsage, () => {});
          return;
        }
        case 'subagents': {
          const all = subagentList(view);
          setView((v) =>
            addInfo(
              v,
              all.length
                ? `${all
                    .map(
                      (x, i) =>
                        `${String(i + 1).padStart(2)}. ${'  '.repeat(x.depth)}${x.row.status === 'running' ? '◌' : x.row.status === 'ok' ? '✓' : '✗'} ${x.row.agent}: ${x.row.task} · ${x.row.toolCalls} tool calls`,
                    )
                    .join('\n')}\n/subagent <number> for details`
                : 'no subagents in this session yet',
            ),
          );
          return;
        }
        case 'subagent': {
          const all = subagentList(view);
          const pick =
            args[0] && /^\d+$/.test(args[0])
              ? all[Number(args[0]) - 1]
              : all.find((x) => x.id === args[0]);
          const child = pick && childView(view, pick.id);
          setView((v) =>
            addInfo(
              v,
              child && pick
                ? `── ${pick.row.agent}: ${pick.row.task} ──\n${describeSession(child)}`
                : 'usage: /subagent <number from /subagents>',
            ),
          );
          return;
        }
        case 'mcp': {
          const { servers } = await client.request('mcp.list', {});
          setView((v) => addInfo(v, `MCP servers\n${formatMcpServers(servers)}`));
          return;
        }
        case 'copy': {
          const reply = view.items.findLast((it) => it.kind === 'assistant' && it.text);
          if (reply?.kind !== 'assistant') {
            setView((v) => addInfo(v, 'Nothing to copy yet.'));
            return;
          }
          const pick = pickCopy(reply.text, args[0]);
          if ('error' in pick) {
            setView((v) => addInfo(v, `copy: ${pick.error}`));
            return;
          }
          const native = await copyText(pick.text, (s) => stdout.write(s));
          const lines = pick.text.split('\n').length;
          setView((v) =>
            addInfo(
              v,
              `Copied ${pick.what} (${lines} line${lines === 1 ? '' : 's'})${native ? '' : ' through the terminal (OSC 52); if nothing arrived, your terminal needs clipboard access enabled'}.`,
            ),
          );
          return;
        }
        case 'receipt': {
          const u = await client.request('usage.get', { sessionId: session.id });
          setView((v) => addInfo(v, formatReceipt(u, 'This session, including subagents')));
          return;
        }
        case 'compact': {
          const { compacted } = await client
            .request('session.compact', { sessionId: session.id })
            .catch((err: Error) => {
              setView((v) => addInfo(v, `compact: ${err.message}`));
              return { compacted: true };
            });
          if (!compacted) setView((v) => addInfo(v, 'Nothing to compact yet.'));
          return;
        }
        case 'help':
          setView((v) => addInfo(v, HELP));
          return;
        case 'exit':
        case 'quit':
          exit();
          return;
        default:
          setView((v) => addInfo(v, `unknown command /${cmd}; try /help`));
          return;
      }
    }
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
      const decision =
        ch === 'y'
          ? 'allow_once'
          : ch === 'a'
            ? 'allow_always'
            : ch === 'n' || key.escape
              ? 'deny'
              : undefined;
      if (!decision) return;
      client
        .request('permission.respond', { requestId: permission.requestId, decision })
        .catch(() => {});
      setView((v) => resolvePermission(v, permission.requestId, decision));
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
            <Box key="header" flexDirection="column" marginBottom={1}>
              <Text bold>
                harness <Text dimColor>{init.engineVersion}</Text>
              </Text>
              <Text dimColor>{init.workspaceRoot} · /help for commands</Text>
            </Box>
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
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text>
            Allow <Text bold>{permission.summary}</Text>?
          </Text>
          {permission.preview ? (
            <DiffView diff={permission.preview} maxLines={Math.max(6, (stdout.rows ?? 30) - 12)} />
          ) : null}
          <Text dimColor>[y] once [a] always this session [n] deny</Text>
        </Box>
      )}
      {escalation && !permission && (
        <Box borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column">
          <Text>
            Escalate to <Text bold>{escalation.target.model}</Text>
            {escalation.estimatedCostUsd !== undefined ? (
              <Text color="yellow"> ({estimateLabel(escalation.estimatedCostUsd)})</Text>
            ) : null}
            ? {escalation.reason}
          </Text>
          <Text dimColor>[y] use remote for this turn [n] stay local</Text>
        </Box>
      )}

      <Box borderStyle="round" borderColor={view.running ? 'gray' : 'cyan'} paddingX={1}>
        <PromptInput
          focus={!permission && !escalation}
          busy={view.running}
          history={history.list()}
          root={init.workspaceRoot}
          onSubmit={submit}
          placeholder={
            view.running ? 'working (esc to cancel)' : 'Ask anything, @ to mention a file, /help'
          }
        />
      </Box>
      <StatusBar session={session} route={route} review={review} view={view} usage={usage} />
    </Box>
  );
}

function StatusBar({
  session,
  route,
  review,
  view,
  usage,
}: {
  session: SessionSummary;
  route: RoutePreference;
  review: boolean | undefined;
  view: ViewState;
  usage?: UsageReport;
}) {
  const tier = view.lastTier;
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text dimColor>
        {session.agent} · route {route}
        {review !== undefined ? ` · review ${review ? 'on' : 'off'}` : ''}
        {tier ? ' · last ' : ''}
        {tier ? <Text color={tier === 'local' ? 'green' : 'yellow'}>{tier}</Text> : null}
        {view.private ? <Text color="cyan"> · 🔒 local only</Text> : null}
      </Text>
      <Text dimColor>
        session ${view.costUsd.toFixed(4)}
        {view.savingsUsd > 0.005 ? ` (saved ~$${view.savingsUsd.toFixed(2)})` : ''}
        {usage
          ? ` · today $${usage.budget.spentTodayUsd.toFixed(2)}${usage.budget.dailyUsd ? `/$${usage.budget.dailyUsd.toFixed(2)}` : ''} · saved ~$${usage.estimatedSavingsUsd.toFixed(2)}`
          : ''}
      </Text>
    </Box>
  );
}

/** Colored unified diff, cut to fit the terminal. */
function DiffView({ diff, maxLines }: { diff: string; maxLines: number }) {
  const lines = diff.split('\n').filter((l) => !l.startsWith('---') && !l.startsWith('+++'));
  const shown = lines.slice(0, maxLines);
  return (
    <Box flexDirection="column" marginY={1}>
      {shown.map((line, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: static snapshot of diff lines
          key={i}
          color={
            line.startsWith('+')
              ? 'green'
              : line.startsWith('-')
                ? 'red'
                : line.startsWith('@@')
                  ? 'cyan'
                  : undefined
          }
          dimColor={!/^[-+@]/.test(line)}
        >
          {line || ' '}
        </Text>
      ))}
      {lines.length > shown.length ? (
        <Text dimColor>… {lines.length - shown.length} more lines</Text>
      ) : null}
    </Box>
  );
}

/** Route rows that add nothing: a default/sticky decision for the model already in use. */
/** A running subagent's latest activity, indented under its row (nested for depth 2). */
function LiveChild({ view, depth }: { view: ViewState; depth: number }) {
  const recent = view.items.filter((i) => i.kind !== 'user' && i.kind !== 'info').slice(-3);
  return (
    <Box flexDirection="column" marginLeft={2 * depth}>
      {recent.map((it) => (
        <Box key={it.id} flexDirection="column">
          {it.kind === 'assistant' ? (
            <Text dimColor wrap="truncate-end">
              {(it.text || it.reasoning).replace(/\s+/g, ' ').slice(-160)}
            </Text>
          ) : (
            <Item item={it} hidden={false} width={80} />
          )}
          {it.kind === 'subagent' && it.status === 'running' && view.children[it.id] ? (
            <LiveChild view={view.children[it.id] as ViewState} depth={depth + 1} />
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

function quietRoutes(items: ViewItem[]): Set<string> {
  const quiet = new Set<string>();
  let current: string | undefined;
  for (const it of items) {
    if (it.kind !== 'route') continue;
    if (['default', 'sticky', 'history'].includes(it.rule) && it.model.model === current)
      quiet.add(it.id);
    current = it.model.model;
  }
  return quiet;
}

function Item({
  item,
  hidden,
  width,
  final = false,
}: {
  item: ViewItem;
  hidden: boolean;
  width: number;
  /** Committed items render Markdown; live ones stay plain while streaming. */
  final?: boolean;
}) {
  if (hidden) return null;
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text bold color="cyan">
            ❯ {item.text}
          </Text>
        </Box>
      );
    case 'info':
      return <Text dimColor>{item.text}</Text>;
    case 'route': {
      const color = item.tier === 'local' ? 'green' : 'yellow';
      return (
        <Text color={color} dimColor={item.rule === 'default'}>
          {item.tier === 'local' ? '⌂' : '☁'} {item.model.model}
          <Text dimColor> · {item.reason}</Text>
        </Text>
      );
    }
    case 'assistant':
      return (
        <Box flexDirection="column">
          {item.reasoning && !item.text ? (
            <Text dimColor italic>
              ✻ {item.reasoning.slice(-200).replace(/\s+/g, ' ')}
            </Text>
          ) : null}
          {item.text ? <Text>{final ? renderMarkdown(item.text, width) : item.text}</Text> : null}
        </Box>
      );
    case 'tool': {
      const icon = item.status === 'running' ? '●' : item.status === 'ok' ? '✓' : '✗';
      const color = item.status === 'running' ? 'yellow' : item.status === 'ok' ? 'green' : 'red';
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={color}>{icon}</Text> {toolLabel(item.name, item.input)}
            {item.private ? <Text color="cyan"> 🔒 stays local</Text> : null}
          </Text>
          {item.status === 'error' && item.output ? (
            <Text color="red" dimColor>
              {' '}
              {item.output.split('\n')[0]}
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'subagent': {
      const icon = item.status === 'running' ? '◌' : item.status === 'ok' ? '✓' : '✗';
      return (
        <Text>
          <Text color="magenta">
            ↳ {icon} {item.agent}
          </Text>{' '}
          {item.task}
          <Text dimColor>
            {item.background ? ' · background' : ''}
            {item.tier ? ` · ${item.tier}` : ''} · {item.toolCalls} tool calls
            {item.status === 'running' && item.activity ? ` · ${item.activity}` : ''}
          </Text>
        </Text>
      );
    }
    case 'review': {
      const [head, ...issues] = reviewLines(item);
      const color =
        item.verdict === 'approve' ? 'green' : item.verdict === 'revise' ? 'yellow' : undefined;
      return (
        <Box flexDirection="column">
          <Text color={color} dimColor={item.verdict === 'skipped'}>
            {head}
          </Text>
          {issues.map((line) => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      );
    }
    case 'error':
      return <Text color="red">error: {item.message}</Text>;
  }
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
