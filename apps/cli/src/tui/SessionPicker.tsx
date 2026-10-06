/** Choosing a saved session to resume: type to filter, ↑/↓ to choose, Enter to open. */
import type { SessionSummary } from '@switchback/protocol';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

const ROWS = 10;

/** Sessions whose title, agent, or ID contains every typed word, newest first as given. */
export function filterSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return sessions.filter((s) => {
    const hay = `${s.title} ${s.agent} ${s.id}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function SessionPicker({
  sessions,
  current,
  onPick,
  onCancel,
}: {
  sessions: SessionSummary[];
  current: string;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const shown = filterSessions(sessions, query);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(shown.length - 1, i + 1));
    if (key.return) {
      const pick = shown[selected];
      if (pick) onPick(pick.id);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return setSelected(0);
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setQuery((q) => q + input);
      setSelected(0);
    }
  });

  const start = Math.min(Math.max(0, selected - ROWS + 1), Math.max(0, shown.length - ROWS));
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text>
        <Text bold>Resume a session</Text>
        <Text dimColor> · {query ? `matching "${query}"` : 'type to filter'}</Text>
      </Text>
      {shown.length === 0 ? (
        <Text dimColor>
          {sessions.length ? 'no sessions match' : 'no saved sessions in this workspace yet'}
        </Text>
      ) : (
        shown.slice(start, start + ROWS).map((s, i) => {
          const on = start + i === selected;
          return (
            <Text key={s.id} wrap="truncate-end">
              <Text color="cyan">{on ? '› ' : '  '}</Text>
              <Text bold={on} color={on ? 'cyan' : undefined}>
                {s.title || '(untitled)'}
              </Text>
              <Text dimColor>
                {'  '}
                {s.agent} · {ago(s.updatedAt)} · ${s.costUsd.toFixed(3)}
                {s.id === current ? ' · current' : ''}
              </Text>
            </Text>
          );
        })
      )}
      <Text dimColor>
        {shown.length > ROWS ? `${selected + 1}/${shown.length} · ` : ''}↑↓ choose · enter open ·
        esc close
      </Text>
    </Box>
  );
}
