/**
 * `/ladder` with no argument: build the escalation ladder from the model list.
 * Space puts a model on the ladder or takes it off, `,` makes it an
 * alternative to the step before, [ and ] move its step, Enter applies.
 */
import { joinRung, type Ladder, type ModelChoice, moveRung, toggleRung } from '@switchback/client';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { Keys } from './Chrome.tsx';
import { useTheme } from './theme.ts';

export function LadderEditor({
  choices,
  ladder: initial,
  onApply,
  onCancel,
  onCommand,
}: {
  choices: ModelChoice[];
  ladder: Ladder;
  /** Called after the editor closes; `save` makes the ladder the default. */
  onApply: (ladder: Ladder, save: boolean) => void;
  onCancel: () => void;
  /** Run a slash command (`/models refresh`). */
  onCommand: (text: string) => void;
}) {
  const t = useTheme();
  const [selected, setSelected] = useState(0);
  const [ladder, setLadder] = useState(initial);
  const width = Math.max(0, ...choices.map((c) => c.alias.length));
  const alias = choices[selected]?.alias;

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onCancel();
    if (key.upArrow) return setSelected((i) => Math.max(0, i - 1));
    if (key.downArrow) return setSelected((i) => Math.min(choices.length - 1, i + 1));
    if (input === 'r') return onCommand('/models refresh');
    if (key.return || input === 's') {
      onCancel();
      return onApply(ladder, input === 's');
    }
    if (!alias) return;
    if (input === ' ') setLadder((l) => toggleRung(l, alias));
    else if (input === ',') setLadder((l) => joinRung(l, alias));
    else if (input === '[') setLadder((l) => moveRung(l, alias, -1));
    else if (input === ']') setLadder((l) => moveRung(l, alias, 1));
  });

  const stepOf = (a: string) => ladder.findIndex((step) => step.includes(a));
  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>Escalation ladder</Text>
      <Text dimColor wrap="truncate-end">
        {ladder.length
          ? `hard turns climb: ${ladder.map((step) => step.join(' or ')).join(' → ')}`
          : 'empty: hard turns stay on the model they started on'}
      </Text>
      {choices.map((c, i) => {
        const on = i === selected;
        const step = stepOf(c.alias);
        return (
          <Text key={c.alias} wrap="truncate-end">
            <Text color={t.accent}>{on ? '› ' : '  '}</Text>
            <Text color={t.accent}>{step >= 0 ? `${step + 1}`.padStart(2) : ' ·'} </Text>
            <Text bold={on} color={c.tier === 'local' ? t.local : t.remote}>
              {c.alias.padEnd(width)}
            </Text>
            <Text dimColor>
              {c.model === c.alias ? '' : `  ${c.model}`} · {c.tier}
              {c.roles.length ? ` · ${c.roles.join(', ')}` : ''}
            </Text>
          </Text>
        );
      })}
      <Keys
        keys={[
          ['space', 'add/remove'],
          [',', 'alternative'],
          ['[ ]', 'move'],
          ['enter', 'apply'],
          ['s', 'apply and save'],
          ['esc', 'cancel'],
        ]}
      />
    </Box>
  );
}
