/**
 * Prompt editor: multi-line input, per-workspace history, and @file
 * completion. Newline: Option/Alt+Enter, Shift+Enter (terminals that report
 * it), Ctrl+J, or a trailing backslash before Enter. Pastes arrive whole
 * through bracketed paste, so their newlines never submit (see paste.ts).
 * Ctrl+C clears what's typed; on an empty input it goes to `onInterrupt`.
 * During a turn, Enter queues the prompt and Esc sends it now (interrupt).
 */
import { statSync } from 'node:fs';
import { commandQuery, matchCommands, type SlashCommand } from '@switchback/client';
import { Box, Text, useInput, usePaste } from 'ink';
import { useEffect, useState } from 'react';
import {
  at,
  backspace,
  completeMention,
  deleteForward,
  deleteToLineStart,
  deleteWord,
  type EditorState,
  empty,
  insert,
  lineEnd,
  lineStart,
  mentionAt,
  moveHorizontal,
  moveVertical,
  position,
  rankFiles,
} from './editor.ts';
import { workspaceFiles } from './files.ts';
import {
  chipBefore,
  cleanPaste,
  expandPastes,
  noPastes,
  type Pastes,
  pastedPath,
  pasteInsertion,
  pathInsertion,
} from './paste.ts';

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

interface Props {
  focus: boolean;
  busy: boolean;
  placeholder: string;
  history: readonly string[];
  root: string;
  onSubmit: (text: string) => void;
  /** Ctrl+C on an empty input (with text in it, Ctrl+C clears it instead). */
  onInterrupt: () => void;
  /**
   * While busy: Enter queues the text for the running turn (`onSubmit`), and
   * Esc sends it now, interrupting the turn. Esc with nothing typed cancels.
   */
  onSubmitNow: (text: string) => void;
  onCancel: () => void;
  /** ↑ on an empty input: the last queued prompt, taken back to edit. */
  recall: () => string | undefined;
}

export function PromptInput({
  focus,
  busy,
  placeholder,
  history,
  root,
  onSubmit,
  onInterrupt,
  onSubmitNow,
  onCancel,
  recall,
}: Props) {
  const [state, setState] = useState<EditorState>(empty);
  // Index into history while browsing it; null when editing a fresh prompt.
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [pastes, setPastes] = useState<Pastes>(noPastes);

  const mention = mentionAt(state);
  const suggestions = mention && !menuClosed ? rankFiles(files, mention.query) : [];
  const menuOpen = suggestions.length > 0;
  const query = menuClosed ? undefined : commandQuery(state.value);
  const commands = query === undefined ? [] : matchCommands(query, 'tui');
  const commandsOpen = commands.length > 0;

  // Load the file list the first time a mention starts.
  useEffect(() => {
    if (mention && files.length === 0) void workspaceFiles(root).then(setFiles);
  }, [mention, files.length, root]);

  const edit = (next: EditorState) => {
    setState(next);
    setSelected(0);
    setMenuClosed(false);
  };

  const browse = (delta: -1 | 1): boolean => {
    if (history.length === 0) return false;
    if (histIndex === null) {
      if (delta === 1) return false;
      setDraft(state.value);
      setHistIndex(history.length - 1);
      setState(at(history[history.length - 1] ?? ''));
      return true;
    }
    const next = histIndex + delta;
    if (next >= history.length) {
      setHistIndex(null);
      setState(at(draft));
    } else if (next >= 0) {
      setHistIndex(next);
      setState(at(history[next] ?? ''));
    }
    return true;
  };

  usePaste(
    (raw) => {
      const text = cleanPaste(raw);
      if (!text) return;
      const path = pastedPath(text);
      const mention = path ? pathInsertion(path, root, isFile) : undefined;
      if (mention) return edit(insert(state, mention));
      const r = pasteInsertion(text, pastes);
      setPastes(r.pastes);
      edit(insert(state, r.insert));
    },
    { isActive: focus },
  );

  /** Put `/name` in the input, with a space when arguments follow. */
  const completeCommand = (c: SlashCommand) => {
    const text = `/${c.name}${c.args ? ' ' : ''}`;
    setState(at(text));
    setSelected(0);
  };

  const clear = () => {
    edit(empty);
    setPastes(noPastes);
    setHistIndex(null);
    setDraft('');
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        // Clearing a long paste must never cost the session.
        if (state.value) return clear();
        return onInterrupt();
      }
      if (commandsOpen) {
        if (key.upArrow) return setSelected((i) => (i + commands.length - 1) % commands.length);
        if (key.downArrow) return setSelected((i) => (i + 1) % commands.length);
        const pick = commands[selected] ?? commands[0];
        if (key.tab && pick) return completeCommand(pick);
        if (key.return && !key.meta && !key.shift && pick) {
          // A command that needs an argument waits for it; the rest run now.
          if (pick.args?.startsWith('<')) return completeCommand(pick);
          onSubmit(`/${pick.name}`);
          setState(empty);
          setHistIndex(null);
          setDraft('');
          return;
        }
        if (key.escape) return setMenuClosed(true);
      }
      if (menuOpen) {
        if (key.upArrow)
          return setSelected((i) => (i + suggestions.length - 1) % suggestions.length);
        if (key.downArrow) return setSelected((i) => (i + 1) % suggestions.length);
        if (key.tab || (key.return && !key.meta && !key.shift)) {
          const pick = suggestions[selected];
          if (pick) edit(completeMention(state, pick));
          return;
        }
        if (key.escape) return setMenuClosed(true);
      }

      if (key.escape) {
        if (busy && state.value.trim()) {
          onSubmitNow(expandPastes(state.value, pastes));
          return clear();
        }
        if (!state.value) onCancel();
        return;
      }
      const newline = (key.return && (key.meta || key.shift)) || (input === '\n' && !key.return);
      if (newline) return edit(insert(state, '\n'));
      if (key.return) {
        if (state.value.slice(0, state.cursor).endsWith('\\')) {
          return edit(insert(backspace(state), '\n'));
        }
        if (!state.value.trim()) return;
        onSubmit(expandPastes(state.value, pastes));
        setState(empty);
        setPastes(noPastes);
        setHistIndex(null);
        setDraft('');
        return;
      }
      if (key.upArrow && !state.value) {
        const back = recall();
        if (back !== undefined) return edit(at(back));
      }
      if (key.upArrow) {
        const moved = moveVertical(state, -1);
        if (moved) setState(moved);
        else browse(-1);
        return;
      }
      if (key.downArrow) {
        const moved = moveVertical(state, 1);
        if (moved) setState(moved);
        else browse(1);
        return;
      }
      if (key.leftArrow) return setState(moveHorizontal(state, -1));
      if (key.rightArrow) return setState(moveHorizontal(state, 1));
      if (key.home || (key.ctrl && input === 'a')) return setState(lineStart(state));
      if (key.end || (key.ctrl && input === 'e')) return setState(lineEnd(state));
      if (key.ctrl && input === 'u') return edit(deleteToLineStart(state));
      if (key.ctrl && input === 'w') return edit(deleteWord(state));
      // Most terminals send DEL (0x7f) for Backspace, which Ink reports either way.
      if (key.backspace) {
        // A paste chip goes in one keystroke, like the paste that made it.
        const chip = key.meta ? undefined : chipBefore(state.value, state.cursor, pastes);
        if (chip !== undefined)
          return edit({
            value: state.value.slice(0, chip) + state.value.slice(state.cursor),
            cursor: chip,
          });
        return edit(key.meta ? deleteWord(state) : backspace(state));
      }
      if (key.delete)
        return edit(state.cursor < state.value.length ? deleteForward(state) : backspace(state));
      if (key.ctrl || key.meta || key.escape || key.tab) return;
      if (input) edit(insert(state, input));
    },
    { isActive: focus },
  );

  const { line: curLine, column: curCol, lines } = position(state);
  return (
    <Box flexDirection="column">
      {state.value === '' ? (
        <Text>
          <Text color="cyan">{busy ? '… ' : '❯ '}</Text>
          {focus ? <Text inverse> </Text> : null}
          <Text dimColor>{placeholder}</Text>
        </Text>
      ) : (
        lines.map((raw, i) => {
          // One cell per character keeps the cursor where the text says it is.
          const text = raw.replaceAll('\t', ' ');
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of the current buffer
            <Text key={i}>
              <Text color="cyan">{i === 0 ? (busy ? '… ' : '❯ ') : '  '}</Text>
              {focus && i === curLine ? (
                <>
                  {text.slice(0, curCol)}
                  <Text inverse>{text[curCol] ?? ' '}</Text>
                  {text.slice(curCol + 1)}
                </>
              ) : (
                text
              )}
            </Text>
          );
        })
      )}
      {commandsOpen ? <CommandMenu commands={commands} selected={selected} /> : null}
      {menuOpen ? (
        <Box flexDirection="column" marginTop={1}>
          {suggestions.map((path, i) => (
            <Text key={path} color={i === selected ? 'cyan' : undefined} dimColor={i !== selected}>
              {i === selected ? '› ' : '  '}@{path}
            </Text>
          ))}
          <Text dimColor>tab/enter to insert · esc to dismiss</Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** Rows shown at once; the window scrolls to keep the selection in view. */
const MENU_ROWS = 8;
const NAME_COLUMN = 22;

function CommandMenu({ commands, selected }: { commands: SlashCommand[]; selected: number }) {
  const start = Math.min(
    Math.max(0, selected - MENU_ROWS + 1),
    Math.max(0, commands.length - MENU_ROWS),
  );
  const shown = commands.slice(start, start + MENU_ROWS);
  // Capped so one long argument hint doesn't push every description off screen.
  const width = Math.min(
    NAME_COLUMN,
    Math.max(...commands.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0))),
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((c, i) => {
        const on = start + i === selected;
        // The argument hint, cut to the column; /help has it in full.
        const room = Math.max(0, width - c.name.length);
        const args = c.args ? ` ${c.args}` : '';
        const hint = args.length > room ? `${args.slice(0, room - 1)}…` : args.padEnd(room);
        return (
          <Text key={c.name} wrap="truncate-end">
            <Text color="cyan">{on ? '› ' : '  '}</Text>
            <Text color={on ? 'cyan' : undefined} bold={on}>
              {`/${c.name}`}
            </Text>
            <Text dimColor>{`${hint}  `}</Text>
            <Text dimColor={!on}>{c.description}</Text>
          </Text>
        );
      })}
      <Text dimColor>
        {commands.length > MENU_ROWS ? `${selected + 1}/${commands.length} · ` : ''}↑↓ choose ·
        enter run · tab complete · esc close
      </Text>
    </Box>
  );
}
