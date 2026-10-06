/** Everything around the transcript: header, prompts, spinner, and status bar. */
import { homedir } from 'node:os';
import { formatLadder, modeLabel, type ViewState } from '@switchback/client';
import type {
  PermissionMode,
  RoutePreference,
  SessionSummary,
  UsageReport,
} from '@switchback/protocol';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

const MODE_COLORS: Record<PermissionMode, string> = {
  default: 'white',
  acceptEdits: 'magenta',
  plan: 'cyan',
  bypassPermissions: 'red',
};

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
  const tier = view.lastTier;
  const ladder = formatLadder(view.ladder);
  const routeColor = route === 'local' ? 'green' : route === 'remote' ? 'yellow' : undefined;
  return (
    <Box justifyContent="space-between" paddingX={1} gap={2}>
      <Text dimColor wrap="truncate-end">
        <Text color="white">{session.agent}</Text>
        {' · '}
        <Text color={routeColor}>{route}</Text>
        {mode !== 'default' ? (
          <Text color={MODE_COLORS[mode]}> · {modeLabel(mode)} (shift+tab)</Text>
        ) : null}
        {review !== undefined ? ` · review ${review ? 'on' : 'off'}` : ''}
        {tier ? (
          <Text color={tier === 'local' ? 'green' : 'yellow'}>
            {' '}
            {tier === 'local' ? '⌂' : '☁'} {tier}
          </Text>
        ) : null}
        {ladder ? ` · ${ladder}` : ''}
        {view.private ? <Text color="cyan"> · 🔒 local only</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-start">
        <Text color="white">${view.costUsd.toFixed(4)}</Text>
        {view.savingsUsd > 0.005 ? ` saved ~$${view.savingsUsd.toFixed(2)}` : ''}
        {usage
          ? ` · today $${usage.budget.spentTodayUsd.toFixed(2)}${usage.budget.dailyUsd ? `/$${usage.budget.dailyUsd.toFixed(2)}` : ''} · week saved ~$${usage.estimatedSavingsUsd.toFixed(2)}`
          : ''}
      </Text>
    </Box>
  );
}

/** Key hints for a prompt: the key highlighted, then what it does. */
export function Keys({ keys }: { keys: [string, string][] }) {
  return (
    <Text>
      {keys.map(([k, what], i) => (
        <Text key={k}>
          {i ? '   ' : ''}
          <Text color="cyan" bold>
            {k}
          </Text>{' '}
          <Text dimColor>{what}</Text>
        </Text>
      ))}
    </Text>
  );
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Shown while a turn runs: a spinner, what's happening, and how long it's taken. */
export function Working({ view }: { view: ViewState }) {
  const [started] = useState(Date.now);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.floor((Date.now() - started) / 1000);
  const last = view.items.findLast((i) => i.kind !== 'info' && i.kind !== 'user');
  const doing =
    last?.kind === 'tool' && last.status === 'running'
      ? // The row above already shows the call; name it rather than repeat it.
        `Running ${last.name}`
      : last?.kind === 'assistant' && last.reasoning && !last.text
        ? 'Thinking'
        : last?.kind === 'subagent' && last.status === 'running'
          ? `Waiting on ${last.agent}`
          : 'Working';
  return (
    <Box>
      <Text wrap="truncate-end">
        <Text color="cyan">{SPINNER[tick % SPINNER.length]}</Text> <Text>{doing}…</Text>
        <Text dimColor> ({seconds}s · esc to cancel)</Text>
      </Text>
    </Box>
  );
}

export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Colored unified diff, cut to fit the terminal. */
export function DiffView({ diff, maxLines }: { diff: string; maxLines: number }) {
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

export function Header({ version, root, width }: { version: string; root: string; width: number }) {
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={Math.min(width, 64)}
    >
      <Text>
        <Text color="cyan" bold>
          ◆ Switchback
        </Text>{' '}
        <Text dimColor>v{version}</Text>
      </Text>
      <Text dimColor wrap="truncate-middle">
        {tildify(root)}
      </Text>
      <Text dimColor>
        <Text color="white">/</Text> commands · <Text color="white">@</Text> mention a file ·{' '}
        <Text color="white">esc</Text> cancel
      </Text>
    </Box>
  );
}
