/** Everything around the transcript: the welcome card, the working line, and the status bar. */
import { homedir } from 'node:os';
import {
  formatLadder,
  formatTodos,
  modeLabel,
  runningShells,
  speedLabel,
  type TodoItem,
  type ViewState,
} from '@switchback/client';
import type {
  InitializeResult,
  PermissionMode,
  QueuedPrompt,
  RoutePreference,
  SessionRoles,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { type Theme, useTheme } from './theme.ts';

export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Key hints: the key highlighted, then what it does. */
export function Keys({ keys }: { keys: [string, string][] }) {
  const t = useTheme();
  return (
    <Text>
      {keys.map(([k, what], i) => (
        <Text key={k}>
          {i ? '   ' : ''}
          <Text color={t.accent} bold>
            {k}
          </Text>{' '}
          <Text dimColor>{what}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** A role's models as people know them: `qwen3-coder (local)`. */
function describeAliases(aliases: string[], init: InitializeResult): string {
  return aliases
    .map((alias) => {
      const m = init.models.find((x) => x.alias === alias);
      return m ? `${m.ref.model} (${m.tier})` : alias;
    })
    .join(', ');
}

/** The welcome card at the top of the transcript: what's running, where, and how. */
export function Header({
  init,
  roles,
  mode,
  width,
}: {
  init: InitializeResult;
  roles?: SessionRoles;
  mode: PermissionMode;
  width: number;
}) {
  const t = useTheme();
  const start = roles?.start?.length ? describeAliases(roles.start, init) : undefined;
  const escalate = roles?.escalate?.length
    ? describeAliases(roles.escalate.flat(), init)
    : undefined;
  const rows: [string, string][] = [
    ...(start ? ([['model', start]] as [string, string][]) : []),
    ...(escalate ? ([['escalates to', escalate]] as [string, string][]) : []),
    ['mode', modeLabel(mode)],
    ['directory', tildify(init.workspaceRoot)],
  ];
  const label = Math.max(...rows.map(([k]) => k.length));
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={t.brand}
        paddingX={1}
        width={Math.min(width, 72)}
      >
        <Text>
          <Text color={t.brand} bold>
            ◆ Switchback
          </Text>{' '}
          <Text dimColor>v{init.engineVersion}</Text>
        </Text>
        <Text> </Text>
        {rows.map(([k, v]) => (
          <Text key={k} wrap="truncate-middle">
            <Text dimColor>{k.padEnd(label)} </Text> {v}
          </Text>
        ))}
      </Box>
      <Text dimColor>
        {'  '}/ commands · @ files · shift+tab mode · ctrl+o expand · PgUp/PgDn scroll
      </Text>
    </Box>
  );
}

/** Prompts waiting for the running turn's next step. */
export function Queue({ queue }: { queue: QueuedPrompt[] }) {
  return (
    <Box flexDirection="column">
      {queue.map((q) => (
        <Text key={q.id} dimColor wrap="truncate-end">
          {'  '}⧗ queued: {q.text.replace(/\s+/g, ' ')}
        </Text>
      ))}
      <Text dimColor>
        {'  '}↑ to edit the last one · esc on an empty prompt cancels the turn and the queue
      </Text>
    </Box>
  );
}

/** The model's checklist while there's work left on it. */
export function Todos({ todos }: { todos: TodoItem[] }) {
  const t = useTheme();
  const lines = formatTodos(todos);
  return (
    <Box flexDirection="column" marginBottom={1}>
      {todos.map((todo, i) => (
        <Text
          key={lines[i]}
          wrap="truncate-end"
          dimColor={todo.status === 'done'}
          strikethrough={todo.status === 'done'}
          color={todo.status === 'in_progress' ? t.accent : undefined}
          bold={todo.status === 'in_progress'}
        >
          {'  '}
          {lines[i]}
        </Text>
      ))}
    </Box>
  );
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** `1.2k`, `850`. */
function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

/** About how many tokens the model has written since the prompt: the text it streamed, at ~4 characters a token. */
export function streamedTokens(view: ViewState): number {
  const from = view.items.findLastIndex((i) => i.kind === 'user');
  let chars = 0;
  for (const item of view.items.slice(from + 1))
    if (item.kind === 'assistant') chars += item.text.length + item.reasoning.length;
  return chars / 4;
}

/** A word with a band of light sweeping across it, the way a busy UI breathes. */
function Shimmer({ text, tick, theme }: { text: string; tick: number; theme: Theme }) {
  if (!theme.brand) return <Text bold>{text}</Text>;
  const at = tick % (text.length + 8);
  return (
    <Text>
      {[...text].map((ch, i) => {
        const near = Math.abs(i - at + 4) <= 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: characters of a fixed word
          <Text key={i} color={near ? theme.accent : theme.brand} bold={near}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
}

/** Shown while a turn runs: what's happening, on which model, for how long, and how much it's written. */
export function Working({ view }: { view: ViewState }) {
  const t = useTheme();
  const [started] = useState(Date.now);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - started) / 1000);
  const last = view.items.findLast((i) => i.kind !== 'info' && i.kind !== 'user');
  const doing =
    last?.kind === 'tool' && last.status === 'running'
      ? 'Running'
      : last?.kind === 'assistant' && last.reasoning && !last.text
        ? 'Thinking'
        : last?.kind === 'assistant' && last.text
          ? 'Writing'
          : last?.kind === 'subagent' && last.status === 'running'
            ? `Waiting on ${last.agent}`
            : 'Working';
  const tokens = streamedTokens(view);
  const model = view.ladder?.model ?? view.speed?.model;
  const tier = view.lastTier;
  return (
    <Box marginBottom={1}>
      <Text wrap="truncate-end">
        <Text color={t.brand}>{SPINNER[tick % SPINNER.length]}</Text>{' '}
        <Shimmer text={`${doing}…`} tick={tick} theme={t} />
        <Text dimColor>
          {' '}
          ({seconds}s{tokens >= 1 ? ` · ↓ ${compact(tokens)} tokens` : ''}
          {model ? ' · ' : ''}
        </Text>
        {model ? (
          <Text color={tier === 'local' ? t.local : t.remote} dimColor>
            {tier === 'local' ? '⌂' : '☁'} {model}
          </Text>
        ) : null}
        <Text dimColor> · esc to interrupt)</Text>
      </Text>
    </Box>
  );
}

/** The permission mode as a badge; nothing for the default. */
function ModeBadge({ mode }: { mode: PermissionMode }) {
  const t = useTheme();
  if (mode === 'default') return null;
  const icon = { acceptEdits: '⏵⏵', plan: '⏸', bypassPermissions: '⚠' }[mode];
  return (
    <Text color={t.modes[mode]} bold>
      {icon} {modeLabel(mode)}
      <Text dimColor> (shift+tab)</Text>
    </Text>
  );
}

export function StatusBar({
  session,
  route,
  review,
  view,
  usage,
  mode,
}: {
  session: SessionSummary;
  route: RoutePreference;
  review: boolean | undefined;
  view: ViewState;
  usage?: UsageReport;
  mode: PermissionMode;
}) {
  const t = useTheme();
  const shells = runningShells(view.shells);
  const ladder = formatLadder(view.ladder);
  const left = view.context ? 1 - view.context.tokens / view.context.window : undefined;
  const budget = usage?.budget;
  const right = [
    left !== undefined ? `${Math.max(0, Math.round(left * 100))}% context left` : '',
    view.costUsd >= 0.0005 ? `$${view.costUsd.toFixed(view.costUsd < 1 ? 3 : 2)}` : '',
    budget?.dailyUsd
      ? `today $${budget.spentTodayUsd.toFixed(2)}/$${budget.dailyUsd.toFixed(2)}`
      : '',
    view.savingsUsd >= 0.01 ? `saved ~$${view.savingsUsd.toFixed(2)}` : '',
  ].filter(Boolean);
  return (
    <Box justifyContent="space-between" paddingX={1} gap={2}>
      <Text wrap="truncate-end">
        <ModeBadge mode={mode} />
        {mode !== 'default' ? <Text dimColor> · </Text> : null}
        <Text dimColor>
          {session.agent} · {route}
          {review !== undefined ? ` · review ${review ? 'on' : 'off'}` : ''}
          {ladder ? ` · ${ladder}` : ''}
        </Text>
        {view.private ? <Text color={t.accent}> · 🔒 local only</Text> : null}
        {shells ? (
          <Text color={t.warning}>
            {' '}
            · {shells} shell{shells === 1 ? '' : 's'} running
          </Text>
        ) : null}
      </Text>
      <Text wrap="truncate-start">
        {left !== undefined && left < 0.15 ? (
          <Text color={t.warning}>{right[0]}</Text>
        ) : (
          <Text dimColor>{right[0] ?? ''}</Text>
        )}
        <Text dimColor>
          {right.slice(1).length ? `${right[0] ? ' · ' : ''}${right.slice(1).join(' · ')}` : ''}
        </Text>
        {view.speed ? (
          <Text dimColor>
            {right.length ? ' · ' : ''}
            {speedLabel(view.speed.tokensPerSecond)}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}
