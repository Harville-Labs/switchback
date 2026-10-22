/**
 * `/current` or `/model` with no argument: choose a role's model. ↑/↓ to
 * choose, Enter to switch; r asks endpoints for their models again, e opens
 * setup to add or edit models. A click on a model or a key hint does the same.
 */
import type { ChosenRole, ModelChoice } from '@switchback/client';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Chrome.tsx';
import { Clickable } from './Clickable.tsx';
import { useTheme } from './theme.ts';

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

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(choices.length - 1, i + 1));
    // The list follows the engine's models, so it updates in place when the refresh lands.
    if (input === 'r') return onCommand('/models refresh');
    if (input === 'e') return edit();
    const n = /^[1-9]$/.test(input) ? Number(input) - 1 : key.return ? selected : -1;
    choose(choices[n]);
  });

  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>{role === 'current' ? 'Current model' : 'Subagent model'}</Text>
      {choices.length === 0 ? (
        <Text dimColor>No models yet; press e to set some up.</Text>
      ) : (
        choices.map((c, i) => {
          const on = i === selected;
          return (
            <Clickable key={c.alias} onClick={() => choose(c)}>
              <Text wrap="truncate-end">
                <Text color={t.accent}>{on ? '› ' : '  '}</Text>
                <Text dimColor>{i < 9 ? `${i + 1}. ` : '   '}</Text>
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
