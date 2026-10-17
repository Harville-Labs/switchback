/** `/current` with no argument: choose the current model. ↑/↓ to choose, Enter to switch. */
import type { ModelChoice } from '@switchback/client';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Chrome.tsx';
import { useTheme } from './theme.ts';

export function ModelPicker({
  choices,
  onPick,
  onCancel,
}: {
  /** The current model first, as `modelChoices` orders them. */
  choices: ModelChoice[];
  onPick: (alias: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(choices.length - 1, i + 1));
    const n = /^[1-9]$/.test(input) ? Number(input) - 1 : key.return ? selected : -1;
    const pick = choices[n];
    if (pick) onPick(pick.alias);
  });

  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>Current model</Text>
      {choices.length === 0 ? (
        <Text dimColor>No models configured; run switchback init.</Text>
      ) : (
        choices.map((c, i) => {
          const on = i === selected;
          return (
            <Text key={c.alias} wrap="truncate-end">
              <Text color={t.accent}>{on ? '› ' : '  '}</Text>
              <Text dimColor>{i < 9 ? `${i + 1}. ` : '   '}</Text>
              <Text bold={on} color={c.tier === 'local' ? t.local : t.remote}>
                {c.alias}
              </Text>
              <Text dimColor>
                {c.model === c.alias ? '' : `  ${c.model}`} · {c.tier}
                {c.roles.length ? ` · ${c.roles.join(', ')}` : ''}
              </Text>
              {c.current ? <Text color={t.accent}> ● current</Text> : null}
            </Text>
          );
        })
      )}
      <Keys
        keys={[
          ['↑↓', 'choose'],
          ['enter', 'switch'],
          ['esc', 'close'],
        ]}
      />
    </Box>
  );
}
