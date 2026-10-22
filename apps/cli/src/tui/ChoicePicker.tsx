/**
 * A command run with no argument where the argument comes from a known set
 * (`/theme`, `/effort`, `/agent`, ...): pick it from a list instead of
 * typing it. ↑/↓ and Enter, a row's number, or a click run `/command value`.
 */
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Chrome.tsx';
import { Clickable } from './Clickable.tsx';
import { useTheme } from './theme.ts';

export interface Choice {
  /** What follows the command when it runs. */
  value: string;
  /** Shown in place of the value, when it says more. */
  label?: string;
  detail?: string;
  /** The value in effect now; the list opens on it. */
  current?: boolean;
}

export interface ChoiceList {
  title: string;
  /** The command the picked value is passed to, without the slash. */
  command: string;
  choices: Choice[];
  /** Shown when there is nothing to choose. */
  empty?: string;
}

// Nine, so the number keys reach every row shown.
const ROWS = 9;

export function ChoicePicker({
  list,
  onPick,
  onCancel,
}: {
  list: ChoiceList;
  /** The command to run, `/command value`; called after the picker closes. */
  onPick: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const { choices } = list;
  const [selected, setSelected] = useState(() =>
    Math.max(
      0,
      choices.findIndex((c) => c.current),
    ),
  );
  const start = Math.min(Math.max(0, selected - ROWS + 1), Math.max(0, choices.length - ROWS));
  const width = Math.max(0, ...choices.map((c) => (c.label ?? c.value).length));
  const choose = (pick: Choice | undefined) => {
    if (!pick) return;
    onCancel();
    onPick(`/${list.command} ${pick.value}`);
  };

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(choices.length - 1, i + 1));
    const n = /^[1-9]$/.test(input) ? start + Number(input) - 1 : key.return ? selected : -1;
    choose(choices[n]);
  });

  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>{list.title}</Text>
      {choices.length === 0 ? (
        <Text dimColor>{list.empty ?? 'Nothing to choose from.'}</Text>
      ) : (
        choices.slice(start, start + ROWS).map((c, i) => {
          const on = start + i === selected;
          return (
            <Clickable key={c.value} onClick={() => choose(c)}>
              <Text wrap="truncate-end">
                <Text color={t.accent}>{on ? '› ' : '  '}</Text>
                <Text dimColor>{`${i + 1}. `}</Text>
                <Text bold={on}>{(c.label ?? c.value).padEnd(width)}</Text>
                {c.detail ? <Text dimColor>{`  ${c.detail}`}</Text> : null}
                {c.current ? <Text color={t.accent}> ● now</Text> : null}
              </Text>
            </Clickable>
          );
        })
      )}
      <Keys
        keys={[
          ['↑↓', 'choose'],
          ['enter', 'pick'],
          ['esc', 'close', onCancel],
        ]}
      />
    </Box>
  );
}
