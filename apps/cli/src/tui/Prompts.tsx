/**
 * Questions the engine asks: permission, plan approval, and escalation. Each
 * is a short list: arrows and Enter, or the option's number. The old letter
 * keys (y, a, p, n) still work. "No, and tell it what to do instead" opens a
 * line for a note, which the model gets with the refusal.
 */
import {
  estimateLabel,
  type PendingEscalation,
  type PendingPermission,
  permissionWhy,
  toolTitle,
} from '@switchback/client';
import type { PermissionDecision } from '@switchback/protocol';
import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { DiffView } from './Diff.tsx';
import { renderMarkdown } from './markdown.ts';
import { useTheme } from './theme.ts';

export interface PermissionAnswer {
  decision: PermissionDecision;
  save?: 'project';
  feedback?: string;
}

interface Choice<T> {
  label: string;
  hint?: string;
  /** A letter that picks it too, from before the list. */
  key?: string;
  value: T;
}

/**
 * Arrow-key list state and keys. `onFeedback` set means the last choice asks
 * for a note before answering.
 */
function useChoice<T>(
  choices: Choice<T>[],
  onPick: (value: T) => void,
  opts: { active: boolean; cancel: T },
) {
  const [selected, setSelected] = useState(0);
  useInput(
    (ch, key) => {
      if (key.upArrow) return setSelected((i) => (i + choices.length - 1) % choices.length);
      if (key.downArrow) return setSelected((i) => (i + 1) % choices.length);
      if (key.return) {
        const pick = choices[selected];
        if (pick) onPick(pick.value);
        return;
      }
      if (key.escape || (key.ctrl && ch === 'c')) return onPick(opts.cancel);
      const n = Number(ch);
      if (n >= 1 && n <= choices.length) return onPick((choices[n - 1] as Choice<T>).value);
      const lettered = choices.find((c) => c.key === ch);
      if (lettered) onPick(lettered.value);
    },
    { isActive: opts.active },
  );
  return selected;
}

function ChoiceList<T>({ choices, selected }: { choices: Choice<T>[]; selected: number }) {
  const t = useTheme();
  return (
    <Box flexDirection="column">
      {choices.map((c, i) => {
        const on = i === selected;
        return (
          <Text key={c.label} wrap="truncate-end">
            <Text color={t.accent}>{on ? '❯ ' : '  '}</Text>
            <Text color={on ? t.accent : undefined} bold={on}>
              {i + 1}. {c.label}
            </Text>
            {c.hint ? <Text dimColor> {c.hint}</Text> : null}
          </Text>
        );
      })}
    </Box>
  );
}

/** A titled panel: what's being asked, then its details, then the choices. */
function Panel({
  title,
  color,
  children,
}: {
  title: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={color} bold>
        {title}
      </Text>
      {children}
    </Box>
  );
}

type PermissionChoice = 'once' | 'always' | 'project' | 'deny' | 'tell';

export function PermissionPrompt({
  permission: p,
  maxLines,
  width,
  onAnswer,
}: {
  permission: PendingPermission;
  maxLines: number;
  width: number;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  if (p.plan)
    return <PlanPrompt plan={p.plan} maxLines={maxLines} width={width} onAnswer={onAnswer} />;
  return <ToolPermission p={p} maxLines={maxLines} width={width} onAnswer={onAnswer} />;
}

function ToolPermission({
  p,
  maxLines,
  width,
  onAnswer,
}: {
  p: PendingPermission;
  maxLines: number;
  width: number;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  const t = useTheme();
  const [note, showNote] = useState<string | undefined>();
  // Keys can arrive faster than renders (a paste ending in Enter): the ref is
  // the note as typed so far, and the state only draws it.
  const typed = useRef<string | undefined>(undefined);
  const setNote = (next: string | undefined) => {
    typed.current = next;
    showNote(next);
  };
  const always = p.rules?.join(', ');
  const choices: Choice<PermissionChoice>[] = [
    { label: 'Yes', key: 'y', value: 'once' },
    ...(always
      ? ([
          {
            label: "Yes, and don't ask again this session",
            hint: `(${always})`,
            key: 'a',
            value: 'always',
          },
          {
            label: 'Yes, and always in this project',
            hint: '(.switchback/config.local.json)',
            key: 'p',
            value: 'project',
          },
        ] as Choice<PermissionChoice>[])
      : []),
    { label: 'No', key: 'n', value: 'deny' },
    { label: 'No, and tell it what to do instead', value: 'tell' },
  ];
  const pick = (c: PermissionChoice) => {
    if (c === 'tell') return setNote('');
    onAnswer(
      c === 'once'
        ? { decision: 'allow_once' }
        : c === 'always'
          ? { decision: 'allow_always' }
          : c === 'project'
            ? { decision: 'allow_always', save: 'project' }
            : { decision: 'deny' },
    );
  };
  const selected = useChoice(choices, pick, { active: note === undefined, cancel: 'deny' });
  useInput(
    (ch, key) => {
      const current = typed.current;
      if (current === undefined) return;
      if (key.escape) return setNote(undefined);
      if (key.return) {
        const feedback = current.trim();
        return onAnswer({ decision: 'deny', ...(feedback ? { feedback } : {}) });
      }
      if (key.backspace || key.delete) return setNote(current.slice(0, -1));
      if (key.ctrl || key.meta || key.tab) return;
      if (ch) setNote(current + ch);
    },
    { isActive: note !== undefined },
  );

  const title = toolTitle(p.tool, undefined);
  const isEdit = p.tool === 'edit' || p.tool === 'write';
  const why = permissionWhy(p);
  const heading = isEdit
    ? p.preview && /^@@ -0,0 /m.test(p.preview)
      ? 'Create file'
      : 'Edit file'
    : p.tool === 'bash'
      ? 'Run command'
      : p.tool.startsWith('mcp__')
        ? `Use ${title.verb}`
        : `Allow ${title.verb.toLowerCase()}`;
  return (
    <Panel title={heading} color={t.warning}>
      <Box marginY={1} marginLeft={2} flexDirection="column">
        <Text bold wrap="wrap">
          {isEdit
            ? p.summary.replace(/^(edit|write) /, '').replace(/ \(\d+ chars\)$/, '')
            : p.summary}
        </Text>
        {why ? <Text dimColor>{why}</Text> : null}
      </Box>
      {p.preview ? (
        <Box marginBottom={1}>
          <DiffView diff={p.preview} maxLines={maxLines} width={width - 4} />
        </Box>
      ) : null}
      <Text>Do you want to go ahead?</Text>
      <ChoiceList choices={choices} selected={selected} />
      {note !== undefined ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={t.accent}>↳ </Text>
            {note}
            <Text inverse> </Text>
          </Text>
          <Text dimColor> enter to send · esc to go back</Text>
        </Box>
      ) : (
        <Text dimColor>↑↓ choose · enter or 1-{choices.length} to answer · esc to decline</Text>
      )}
    </Panel>
  );
}

type PlanChoice = 'approve' | 'accept' | 'keep';

function PlanPrompt({
  plan,
  maxLines,
  width,
  onAnswer,
}: {
  plan: string;
  maxLines: number;
  width: number;
  onAnswer: (answer: PermissionAnswer) => void;
}) {
  const t = useTheme();
  const choices: Choice<PlanChoice>[] = [
    { label: 'Approve', key: 'y', value: 'approve' },
    { label: 'Approve and accept edits', key: 'a', value: 'accept' },
    { label: 'Keep planning', key: 'n', value: 'keep' },
  ];
  const selected = useChoice(
    choices,
    (c) =>
      onAnswer({
        decision: c === 'approve' ? 'allow_once' : c === 'accept' ? 'allow_always' : 'deny',
      }),
    { active: true, cancel: 'keep' },
  );
  const lines = renderMarkdown(plan, width - 4).split('\n');
  const shown = lines.slice(0, maxLines);
  return (
    <Panel title="Plan" color={t.modes.plan ?? t.accent}>
      <Box marginY={1} flexDirection="column">
        <Text>{shown.join('\n')}</Text>
        {lines.length > shown.length ? (
          <Text dimColor>… {lines.length - shown.length} more lines</Text>
        ) : null}
      </Box>
      <ChoiceList choices={choices} selected={selected} />
    </Panel>
  );
}

export function EscalationPrompt({
  escalation,
  onAnswer,
}: {
  escalation: PendingEscalation;
  onAnswer: (approve: boolean) => void;
}) {
  const t = useTheme();
  const cost =
    escalation.estimatedCostUsd !== undefined ? estimateLabel(escalation.estimatedCostUsd) : '';
  const choices: Choice<boolean>[] = [
    {
      label: `Escalate to ${escalation.target.model}`,
      hint: cost ? `(${cost})` : '',
      key: 'y',
      value: true,
    },
    { label: 'Stay on the current model', key: 'n', value: false },
  ];
  const selected = useChoice(choices, onAnswer, { active: true, cancel: false });
  return (
    <Panel title="Escalate?" color={t.remote}>
      <Box marginY={1} marginLeft={2}>
        <Text>{escalation.reason}</Text>
      </Box>
      <ChoiceList choices={choices} selected={selected} />
    </Panel>
  );
}
