/** `/rewind`: pick a checkpoint (the start of a turn), then what to put back. */
import type { CheckpointInfo, SessionRewindParams } from '@switchback/protocol';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Chrome.tsx';
import { ago } from './SessionPicker.tsx';

const ROWS = 8;

export function RewindPicker({
  checkpoints,
  onRewind,
  onCancel,
}: {
  /** Oldest first, as the engine lists them. */
  checkpoints: CheckpointInfo[];
  onRewind: (turnId: string, restore: SessionRewindParams['restore']) => void;
  onCancel: () => void;
}) {
  const newest = [...checkpoints].reverse();
  const [selected, setSelected] = useState(0);
  const [chosen, setChosen] = useState<CheckpointInfo | undefined>();

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c'))
      return chosen ? setChosen(undefined) : onCancel();
    if (chosen) {
      const restore = ({ b: 'both', f: 'files', c: 'conversation' } as const)[input];
      if (restore) onRewind(chosen.turnId, restore);
      return;
    }
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(newest.length - 1, i + 1));
    if (key.return && newest[selected]) setChosen(newest[selected]);
  });

  if (!newest.length)
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text dimColor>No checkpoints yet: each prompt you send makes one.</Text>
        <Keys keys={[['esc', 'close']]} />
      </Box>
    );

  if (chosen)
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text>
          Back to before <Text bold>{chosen.prompt}</Text>
        </Text>
        <Text dimColor>
          {filesSince(checkpoints, chosen)} file(s) changed since then go back; changes made by
          shell commands aren't tracked. The conversation continues in a new session; this one is
          kept.
        </Text>
        <Keys
          keys={[
            ['b', 'files and conversation'],
            ['f', 'files only'],
            ['c', 'conversation only'],
            ['esc', 'back'],
          ]}
        />
      </Box>
    );

  const start = Math.min(Math.max(0, selected - ROWS + 1), Math.max(0, newest.length - ROWS));
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Text bold>Rewind to before…</Text>
      {newest.slice(start, start + ROWS).map((c, i) => {
        const on = start + i === selected;
        return (
          <Text key={c.turnId} wrap="truncate-end">
            <Text color="cyan">{on ? '› ' : '  '}</Text>
            <Text bold={on} color={on ? 'cyan' : undefined}>
              {c.prompt}
            </Text>
            <Text dimColor>
              {'  '}
              {ago(c.at)}
              {c.files.length ? ` · ${c.files.length} file(s)` : ''}
            </Text>
          </Text>
        );
      })}
      <Keys
        keys={[
          ['↑↓', 'choose'],
          ['enter', 'select'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}

/** How many distinct files changed from this checkpoint on. */
function filesSince(all: CheckpointInfo[], from: CheckpointInfo): number {
  const later = all.slice(all.findIndex((c) => c.turnId === from.turnId));
  return new Set(later.flatMap((c) => c.files)).size;
}
