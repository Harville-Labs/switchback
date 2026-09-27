/**
 * Prompt editor: multi-line input, per-workspace history, and @file
 * completion. Newline: Option/Alt+Enter, Shift+Enter (terminals that report
 * it), Ctrl+J, or a trailing backslash before Enter.
 */
import { Box, Text, useInput } from 'ink';
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

interface Props {
  focus: boolean;
  busy: boolean;
  placeholder: string;
  history: readonly string[];
  root: string;
  onSubmit: (text: string) => void;
}

export function PromptInput({ focus, busy, placeholder, history, root, onSubmit }: Props) {
  const [state, setState] = useState<EditorState>(empty);
  // Index into history while browsing it; null when editing a fresh prompt.
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);

  const mention = mentionAt(state);
  const suggestions = mention && !menuClosed ? rankFiles(files, mention.query) : [];
  const menuOpen = suggestions.length > 0;

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

  useInput(
    (input, key) => {
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

      const newline = (key.return && (key.meta || key.shift)) || (input === '\n' && !key.return);
      if (newline) return edit(insert(state, '\n'));
      if (key.return) {
        if (state.value.slice(0, state.cursor).endsWith('\\')) {
          return edit(insert(backspace(state), '\n'));
        }
        if (busy || !state.value.trim()) return;
        onSubmit(state.value);
        setState(empty);
        setHistIndex(null);
        setDraft('');
        return;
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
      if (key.backspace) return edit(key.meta ? deleteWord(state) : backspace(state));
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
        lines.map((text, i) => (
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
        ))
      )}
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
