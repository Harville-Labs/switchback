/** Multiplexing in the terminal: the tab bar and the sessions dashboard (ctrl+t, `/tabs`). */
import {
  type DashboardRow,
  STATE_ICONS,
  STATE_LABELS,
  switchTab,
  type TabsState,
  tierIcon,
} from '@switchback/client';
import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { Keys } from './Chrome.tsx';
import type { MouseInput } from './mouse.ts';
import { type Theme, useTheme } from './theme.ts';

function stateColor(row: DashboardRow, t: Theme): string | undefined {
  if (row.state === 'waiting') return t.warning;
  if (row.state === 'failed') return t.error;
  if (row.state === 'running') return t.brand;
  if (row.state === 'done') return t.success;
  return undefined;
}

const SEPARATOR = ' │ ';

export interface TabSpan {
  row: DashboardRow;
  label: string;
  /** The 1-based terminal columns it covers, its state icon included, for clicks. */
  from: number;
  to: number;
}

/** Where each tab sits on the tab bar; empty when the bar is hidden. */
export function tabSpans(rows: DashboardRow[], width: number): TabSpan[] {
  const tabs = rows.filter((r) => r.tab);
  if (tabs.length < 2) return [];
  // Share the line; the tab in front keeps more of its title.
  const room = Math.max(8, Math.floor((width - 4) / tabs.length) - 6);
  // The bar's padding puts the first tab in column 2.
  let x = 2;
  return tabs.map((row, i) => {
    if (i) x += SEPARATOR.length;
    const title = row.title.length > room ? `${row.title.slice(0, room - 1)}…` : row.title;
    const label = ` ${row.tab} ${title} `;
    const from = x;
    x += 1 + label.length;
    return { row, label, from, to: x - 1 };
  });
}

/** The tab under a click on the tab bar's line. */
export function tabAtColumn(spans: TabSpan[], x: number): string | undefined {
  return spans.find((s) => x >= s.from && x <= s.to)?.row.sessionId;
}

/** Where each tab sits on the top line; a click there brings that tab forward. */
export function useTabBar(
  rows: DashboardRow[],
  width: number,
  mouse: MouseInput | undefined,
  setTabs: (update: (t: TabsState) => TabsState) => void,
): TabSpan[] {
  const spans = useMemo(() => tabSpans(rows, width), [rows, width]);
  useEffect(
    () =>
      mouse?.onClick((x, y) => {
        const id = y === 1 ? tabAtColumn(spans, x) : undefined;
        if (id) setTabs((t) => switchTab(t, id));
      }),
    [mouse, spans, setTabs],
  );
  return spans;
}

/** One line of tabs over the transcript, shown once there's more than one. */
export function TabBar({ spans }: { spans: TabSpan[] }) {
  const t = useTheme();
  if (!spans.length) return null;
  return (
    <Box paddingX={1}>
      <Text wrap="truncate-end">
        {spans.map(({ row: r, label }, i) => (
          <Text key={r.sessionId}>
            {i ? <Text dimColor>{SEPARATOR}</Text> : null}
            <Text color={stateColor(r, t)}>{r.state === 'idle' ? ' ' : STATE_ICONS[r.state]}</Text>
            <Text bold={r.active} inverse={r.active} color={r.active ? t.brand : undefined}>
              {label}
            </Text>
          </Text>
        ))}
        <Text dimColor>{'  '}click a tab · ctrl+t all</Text>
      </Text>
    </Box>
  );
}

const ROWS = 12;

/**
 * Every open tab, then sessions working in other windows: ↑/↓ and Enter (or a
 * tab's number) to switch, `n` for a new tab, `x` to close one.
 */
export function Dashboard({
  rows,
  onOpen,
  onNew,
  onClose,
  onCancel,
}: {
  rows: DashboardRow[];
  onOpen: (sessionId: string) => void;
  onNew: () => void;
  onClose: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      rows.findIndex((r) => r.active),
    ),
  );
  const at = Math.min(selected, rows.length - 1);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === 'c' || input === 't'))) return onCancel();
    if (key.upArrow) return setSelected(Math.max(0, at - 1));
    if (key.downArrow) return setSelected(Math.min(rows.length - 1, at + 1));
    if (input === 'n') return onNew();
    const row = rows[at];
    if (input === 'x' && row?.tab) return onClose(row.sessionId);
    if (/^[1-9]$/.test(input)) {
      const pick = rows.find((r) => r.tab === Number(input));
      if (pick) onOpen(pick.sessionId);
      return;
    }
    if (key.return && row) onOpen(row.sessionId);
  });

  const width = Math.min(36, Math.max(12, ...rows.map((r) => r.title.length)));
  const start = Math.min(Math.max(0, at - ROWS + 1), Math.max(0, rows.length - ROWS));
  const firstElsewhere = rows.findIndex((r) => !r.tab);
  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>Sessions</Text>
      {rows.slice(start, start + ROWS).map((r, i) => {
        const on = start + i === at;
        return (
          <Box key={r.sessionId} flexDirection="column">
            {start + i === firstElsewhere ? <Text dimColor>Working in other windows</Text> : null}
            <Text wrap="truncate-end">
              <Text color={t.accent}>{on ? '› ' : '  '}</Text>
              <Text dimColor>{r.tab ? `${r.tab}`.padStart(2) : '  '} </Text>
              <Text color={stateColor(r, t)}>{STATE_ICONS[r.state]} </Text>
              <Text bold={on || r.active}>{r.title.padEnd(width)}</Text>
              <Text color={stateColor(r, t)}>
                {'  '}
                {STATE_LABELS[r.state]}
              </Text>
              {r.model ? (
                <Text color={r.tier === 'local' ? t.local : t.remote} dimColor>
                  {' · '}
                  {tierIcon(r.tier)} {r.model}
                </Text>
              ) : null}
              <Text dimColor>
                {r.doing ? ` · ${r.doing}` : ''}
                {r.costUsd >= 0.0005 ? ` · $${r.costUsd.toFixed(3)}` : ''}
                {r.active ? ' · here' : ''}
              </Text>
            </Text>
          </Box>
        );
      })}
      <Keys
        keys={[
          ['↑↓ enter', 'switch'],
          ['1-9', 'tab'],
          ['n', 'new tab'],
          ['x', 'close tab'],
          ['esc', 'back'],
        ]}
      />
      <Text dimColor>
        A closed tab's session keeps running; alt+1…9 and alt+←/→ switch tabs from the prompt.
      </Text>
    </Box>
  );
}
