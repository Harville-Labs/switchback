/**
 * `/init` in the TUI: the engine's setup, the same questions `switchback init`
 * and VS Code ask, drawn as a panel above the prompt. Notes go into the
 * transcript. Esc on any question cancels setup, as dismissing does in VS Code.
 */
import { formatSetupNote, runSetupOver, type SwitchbackClient } from '@switchback/client';
import type { SetupAnswerParams, SetupOutcome, SetupQuestion } from '@switchback/protocol';
import { Fzf } from 'fzf';
import { Box, Text, useInput } from 'ink';
import { type ReactNode, useRef, useState } from 'react';
import { Keys } from './Chrome.tsx';
import { useTheme } from './theme.ts';

type Answer = SetupAnswerParams['value'];

/** Rows of a long list shown at once, around the selected one. */
const WINDOW = 10;

/** What the transcript says when setup ends. */
export function setupEnded(r: SetupOutcome): string {
  switch (r.outcome) {
    case 'written':
      return `Saved ${r.file ?? 'the configuration'}; it's in use now. /models lists the models, and Tab or /current picks one.`;
    case 'nothing':
      return 'Nothing changed. Run /init any time.';
    case 'cancelled':
      return 'Setup cancelled; nothing was written. Run /init any time.';
    case 'failed':
      return `Setup failed: ${r.message ?? 'no reason given'}`;
  }
}

/** Starts setup and holds the question it's waiting on; `panel` draws that question. */
export function useSetup(client: SwitchbackClient, say: (text: string) => void) {
  const [asking, setAsking] = useState<{
    n: number;
    q: SetupQuestion;
    answer: (v: Answer) => void;
  }>();
  const running = useRef(false);
  const asked = useRef(0);
  const start = () => {
    if (running.current) return say('Setup is already running.');
    running.current = true;
    runSetupOver(client, {
      ask: (q) =>
        new Promise<Answer>((resolve) => {
          asked.current += 1;
          setAsking({
            n: asked.current,
            q,
            answer: (v) => {
              setAsking(undefined);
              resolve(v);
            },
          });
        }),
      note: (note) => say(formatSetupNote(note)),
    })
      .then((r) => say(setupEnded(r)))
      .catch((err: Error) => say(`Setup failed: ${err.message}`))
      .finally(() => {
        running.current = false;
        setAsking(undefined);
      });
  };
  const panel: ReactNode = asking ? (
    <SetupQuestionPanel key={asking.n} question={asking.q} onAnswer={asking.answer} />
  ) : null;
  return { start, active: Boolean(asking), panel };
}

export function SetupQuestionPanel({
  question: q,
  onAnswer,
}: {
  question: SetupQuestion;
  onAnswer: (value: Answer) => void;
}) {
  const t = useTheme();
  return (
    <Box borderStyle="round" borderColor={t.accent} paddingX={1} flexDirection="column">
      <Text bold>Set up · {q.question}</Text>
      {q.kind === 'text' || q.kind === 'number' ? (
        <LineAnswer question={q} onAnswer={onAnswer} />
      ) : (
        <ListAnswer question={q} onAnswer={onAnswer} />
      )}
    </Box>
  );
}

/** A line of typing: text (masked when secret), or a number with an empty line for the default. */
function LineAnswer({
  question: q,
  onAnswer,
}: {
  question: Extract<SetupQuestion, { kind: 'text' | 'number' }>;
  onAnswer: (value: Answer) => void;
}) {
  const t = useTheme();
  const start = q.default === undefined ? '' : String(q.default);
  const [line, show] = useState(q.kind === 'text' ? start : '');
  const [problem, setProblem] = useState<string>();
  // Keys can arrive faster than renders (a pasted key ending in Enter).
  const typed = useRef(line);
  const set = (next: string) => {
    typed.current = next;
    show(next);
  };
  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch === 'c')) return onAnswer(null);
    if (key.return) {
      const v = typed.current.trim();
      if (q.kind === 'text') return onAnswer(typed.current);
      if (!v) return onAnswer('');
      const n = Number(v.replaceAll(',', ''));
      if (Number.isFinite(n) && n > 0) return onAnswer(n);
      return setProblem('Enter a positive number, or leave it empty for the default.');
    }
    if (key.backspace || key.delete) return set(typed.current.slice(0, -1));
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return;
    if (ch) set(typed.current + ch.replace(/[\r\n]+$/, ''));
  });
  const shown = q.kind === 'text' && q.secret ? '•'.repeat(line.length) : line;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={t.accent}>› </Text>
        {shown}
        <Text inverse> </Text>
        {q.kind === 'number' && q.default !== undefined && !line ? (
          <Text dimColor> {q.default.toLocaleString()}</Text>
        ) : null}
      </Text>
      {problem ? <Text color={t.warning}>{problem}</Text> : null}
      <Keys
        keys={[
          ['enter', 'answer'],
          ['esc', 'cancel setup'],
        ]}
      />
    </Box>
  );
}

/** Options to choose from: one (confirm, select, search) or several (multiSelect). */
function ListAnswer({
  question: q,
  onAnswer,
}: {
  question: Extract<SetupQuestion, { kind: 'confirm' | 'select' | 'multiSelect' | 'search' }>;
  onAnswer: (value: Answer) => void;
}) {
  const t = useTheme();
  const options = q.kind === 'confirm' ? [{ label: 'Yes' }, { label: 'No' }] : q.options;
  const [selected, setSelected] = useState(
    q.kind === 'confirm' ? (q.default ? 0 : 1) : q.kind === 'select' ? q.default : 0,
  );
  const [ticked, setTicked] = useState(
    () => new Set(options.flatMap((o, i) => ('checked' in o && o.checked ? [i] : []))),
  );
  const [filter, setFilter] = useState('');
  const [fzf] = useState(
    () =>
      new Fzf(
        options.map((o, i) => ({ label: o.label, i })),
        { selector: (o) => o.label },
      ),
  );
  // Searching shows only the matches, best first; each row keeps its index in `options`.
  const rows =
    q.kind === 'search' && filter
      ? fzf.find(filter).map((m) => m.item.i)
      : options.map((_, i) => i);
  const freeText = q.kind === 'search' && q.freeText && filter.trim() !== '';
  const count = rows.length + (freeText ? 1 : 0);
  const at = Math.min(selected, Math.max(0, count - 1));

  useInput((ch, key) => {
    if (key.escape || (key.ctrl && ch === 'c')) return onAnswer(null);
    if (key.upArrow) return setSelected(Math.max(0, at - 1));
    if (key.downArrow) return setSelected(Math.min(count - 1, at + 1));
    if (key.return) {
      if (q.kind === 'multiSelect') return onAnswer([...ticked].sort((a, b) => a - b));
      const row = rows[at];
      if (row === undefined) return freeText ? onAnswer(filter.trim()) : undefined;
      return onAnswer(q.kind === 'confirm' ? row === 0 : row);
    }
    if (q.kind === 'multiSelect' && ch === ' ') {
      const row = rows[at];
      if (row === undefined) return;
      return setTicked((s) => {
        const next = new Set(s);
        if (!next.delete(row)) next.add(row);
        return next;
      });
    }
    if (q.kind === 'search') {
      if (key.backspace || key.delete) return setFilter((f) => f.slice(0, -1));
      if (ch && !key.ctrl && !key.meta && !key.tab) {
        setFilter((f) => f + ch);
        setSelected(0);
      }
      return;
    }
    if (q.kind === 'confirm' && /^[yn]$/i.test(ch)) return onAnswer(ch.toLowerCase() === 'y');
    const n = /^[1-9]$/.test(ch) ? Number(ch) - 1 : -1;
    const row = rows[n];
    if (row !== undefined && q.kind !== 'multiSelect')
      onAnswer(q.kind === 'confirm' ? row === 0 : row);
  });

  const from = Math.max(0, Math.min(at - Math.floor(WINDOW / 2), count - WINDOW));
  const visible = rows.slice(from, from + WINDOW);
  return (
    <Box flexDirection="column">
      {q.kind === 'search' ? (
        <Text>
          <Text color={t.accent}>filter › </Text>
          {filter}
          <Text inverse> </Text>
        </Text>
      ) : null}
      {from > 0 ? <Text dimColor> ↑ {from} more</Text> : null}
      {visible.map((row, k) => {
        const on = from + k === at;
        const o = options[row];
        return (
          <Text key={row} wrap="truncate-end">
            <Text color={t.accent}>{on ? '› ' : '  '}</Text>
            {q.kind === 'multiSelect' ? <Text>{ticked.has(row) ? '◉ ' : '○ '}</Text> : null}
            <Text bold={on} color={on ? t.accent : undefined}>
              {o?.label}
            </Text>
            {o && 'hint' in o && o.hint ? <Text dimColor> {o.hint}</Text> : null}
          </Text>
        );
      })}
      {rows.length > from + WINDOW ? (
        <Text dimColor> ↓ {rows.length - from - WINDOW} more</Text>
      ) : null}
      {freeText ? (
        <Text color={at === rows.length ? t.accent : undefined} bold={at === rows.length}>
          {at === rows.length ? '› ' : '  '}Use "{filter.trim()}"
        </Text>
      ) : null}
      {q.kind === 'search' && !count ? <Text dimColor> nothing matches</Text> : null}
      <Keys
        keys={[
          ['↑↓', 'choose'],
          ...(q.kind === 'multiSelect' ? ([['space', 'tick']] as [string, string][]) : []),
          ['enter', q.kind === 'multiSelect' ? 'done' : 'answer'],
          ['esc', 'cancel setup'],
        ]}
      />
    </Box>
  );
}
