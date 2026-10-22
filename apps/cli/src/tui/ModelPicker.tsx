/**
 * `/current` or `/model` with no argument: choose a role's model. ↑/↓ to
 * choose (wrapping past either end), 1-9 for a shown row, Enter to switch; r asks endpoints for their models again, e opens
 * setup to add or edit models. A click on a model or a key hint does the same.
 */
import type { ChosenRole, ModelChoice } from '@switchback/client';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Chrome.tsx';
import { Clickable } from './Clickable.tsx';
import { windowStart, wrapStep } from './list.ts';
import { useTheme } from './theme.ts';

// Nine, so the number keys reach every row shown.
const ROWS = 9;

export function ModelPicker({
  role = 'current',
  choices,
  onPick,
  onCancel,
  onCommand,
}: {
  role?: ChosenRole;
  /** The role's model first, as `modelChoices` orders them. */
  choices: ModelChoice[];
  /** Called after the picker closes. */
  onPick: (alias: string) => void;
  onCancel: () => void;
  /** Run a slash command (`/models refresh`, `/init`). */
  onCommand: (text: string) => void;
}) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);
  const width = Math.max(0, ...choices.map((c) => c.alias.length));
  const choose = (pick: ModelChoice | undefined) => {
    if (!pick) return;
    onCancel();
    onPick(pick.alias);
  };
  const edit = () => {
    onCancel();
    onCommand('/init');
  };

  const start = windowStart(selected, choices.length, ROWS);
  const below = choices.length - start - ROWS;

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setSelected((i) => wrapStep(i, -1, choices.length));
    if (key.downArrow) return setSelected((i) => wrapStep(i, 1, choices.length));
    // The list follows the engine's models, so it updates in place when the refresh lands.
    if (input === 'r') return onCommand('/models refresh');
    if (input === 'e') return edit();
    const n = /^[1-9]$/.test(input) ? start + Number(input) - 1 : key.return ? selected : -1;
    choose(choices[n]);
  });

  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>{role === 'current' ? 'Current model' : 'Subagent model'}</Text>
      {start > 0 ? <Text dimColor> ↑ {start} more</Text> : null}
      {choices.length === 0 ? (
        <Text dimColor>No models yet; press e to set some up.</Text>
      ) : (
        choices.slice(start, start + ROWS).map((c, i) => {
          const on = start + i === selected;
          return (
            <Clickable key={c.alias} onClick={() => choose(c)}>
              <Text wrap="truncate-end">
                <Text color={t.accent}>{on ? '› ' : '  '}</Text>
                <Text dimColor>{`${i + 1}. `}</Text>
                <Text bold={on} color={c.tier === 'local' ? t.local : t.remote}>
                  {c.alias.padEnd(width)}
                </Text>
                <Text dimColor>
                  {c.model === c.alias ? '' : `  ${c.model}`} · {c.tier}
                  {c.roles.length ? ` · ${c.roles.join(', ')}` : ''}
                </Text>
                {c.current ? (
                  <Text color={t.accent}> ● {role === 'current' ? 'current' : 'in use'}</Text>
                ) : null}
              </Text>
            </Clickable>
          );
        })
      )}
      {below > 0 ? <Text dimColor> ↓ {below} more</Text> : null}
      <Keys
        keys={[
          ['↑↓', 'choose'],
          ['enter', 'switch'],
          ['r', 'refresh list', () => onCommand('/models refresh')],
          ['e', 'add or edit models', edit],
          ['esc', 'close', onCancel],
        ]}
      />
    </Box>
  );
}
