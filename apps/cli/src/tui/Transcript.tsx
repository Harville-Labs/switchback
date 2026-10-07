/**
 * The full-screen transcript. Each row is rendered to lines once and cached,
 * so a long session costs only what's on screen; the viewport is a window
 * onto those lines that the wheel and Page Up/Down move.
 *
 * The cache keys rows by their items' identity: the view reducer makes a new
 * object only for an item that changed, so a streaming reply re-renders on
 * each delta and everything above it stays as it was.
 */
import { type DisplayRow, displayRows, type ViewItem, type ViewState } from '@switchback/client';
import { Box, renderToString, Text } from 'ink';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { LiveChild, quietRoutes, Row } from './Rows.tsx';
import { type Theme, ThemeContext } from './theme.ts';

/** A stable number per object, for cache keys. */
const ids = new WeakMap<object, number>();
let nextId = 0;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
};

const MAX_CACHED = 4_000;

/** Render once per key; the cache forgets everything when it gets large (a resize does that anyway). */
class LineCache {
  private map = new Map<string, string[]>();

  get(key: string, render: () => string): string[] {
    const hit = this.map.get(key);
    if (hit) return hit;
    if (this.map.size > MAX_CACHED) this.map.clear();
    const out = render();
    // An empty render (a hidden row) takes no lines.
    const lines = out === '' ? [] : out.split('\n');
    this.map.set(key, lines);
    return lines;
  }
}

function rowItems(row: DisplayRow): ViewItem[] {
  return row.kind === 'explore' ? row.calls : [row.item];
}

export interface TranscriptLines {
  lines: string[];
}

/**
 * Every line of the transcript, the header first, at this width. Rows are
 * rendered on the next tick, outside React's render and commit: Ink's layout
 * engine isn't reentrant, so a nested render must wait for the outer one.
 * A change shows a frame later.
 */
export function useTranscriptLines({
  view,
  committed,
  width,
  theme,
  expanded,
  header,
  headerKey,
}: {
  view: ViewState;
  /** Items before this index are finished (Markdown rendered). */
  committed: number;
  width: number;
  theme: Theme;
  expanded: boolean;
  header: ReactNode;
  /** Changes when the header's content does. */
  headerKey: string;
}): string[] {
  const cache = useRef(new LineCache()).current;
  const headerNode = useRef(header);
  headerNode.current = header;
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setLines(renderAll()));
    return () => clearTimeout(timer);
    function renderAll(): string[] {
      const render = (node: ReactNode) =>
        renderToString(<ThemeContext.Provider value={theme}>{node}</ThemeContext.Provider>, {
          columns: width,
        });
      const common = `${width}|${theme.name}|${expanded ? 1 : 0}`;
      const out = [...cache.get(`header|${headerKey}|${common}`, () => render(headerNode.current))];
      const hidden = quietRoutes(view.items);
      const finished = new Set(view.items.slice(0, committed));
      for (const row of displayRows(view.items.filter((i) => !hidden.has(i.id)))) {
        const items = rowItems(row);
        const final = items.every((i) => finished.has(i));
        const first = items[0];
        const child =
          first?.kind === 'subagent' && first.status === 'running'
            ? view.children[first.id]
            : undefined;
        const key = [
          items.map(idOf).join(','),
          child ? idOf(child) : '',
          final ? 'f' : 'l',
          common,
        ].join('|');
        out.push(
          ...cache.get(key, () =>
            render(
              <Box flexDirection="column">
                <Row row={row} width={width} final={final} expanded={expanded} />
                {child ? <LiveChild view={child} depth={1} /> : null}
              </Box>,
            ),
          ),
        );
      }
      return out;
    }
  }, [view, committed, width, theme, expanded, headerKey, cache]);
  return lines;
}

/** The visible slice: `scroll` lines up from the bottom (0 follows the end). */
export function visibleLines(lines: string[], height: number, scroll: number): string[] {
  if (height <= 0) return [];
  const end = Math.max(0, lines.length - scroll);
  return lines.slice(Math.max(0, end - height), end);
}

export function maxScroll(lines: string[], height: number): number {
  return Math.max(0, lines.length - height);
}

export function Viewport({
  lines,
  height,
  scroll,
  unseen,
}: {
  lines: string[];
  height: number;
  scroll: number;
  /** Lines added below while scrolled up. */
  unseen: number;
}) {
  const shown = visibleLines(lines, height, scroll);
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      <Text>{shown.join('\n')}</Text>
      {scroll > 0 ? (
        <Box
          position="absolute"
          marginTop={Math.max(0, height - 1)}
          width="100%"
          justifyContent="center"
        >
          <Text inverse>
            {' '}
            {unseen > 0 ? `↓ ${unseen} new lines · ` : ''}
            {scroll} lines up · PgDn or scroll down to return{' '}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * Scroll position, in lines up from the bottom. At the bottom it follows new
 * output; scrolled up, it holds still as lines arrive below and counts them.
 */
export function useScroll(total: number, height: number) {
  const [scroll, setScroll] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const last = useRef(total);
  useEffect(() => {
    const grew = total - last.current;
    last.current = total;
    if (grew <= 0) return;
    setScroll((s) => (s > 0 ? s + grew : 0));
    setUnseen((u) => (scroll > 0 ? u + grew : 0));
  }, [total, scroll]);
  const limit = Math.max(0, total - height);
  const by = (lines: number) => {
    setScroll((s) => {
      const next = Math.min(limit, Math.max(0, s - lines));
      if (next === 0) setUnseen(0);
      return next;
    });
  };
  return {
    scroll: Math.min(scroll, limit),
    unseen,
    /** Positive scrolls down (toward the end). */
    by,
    page: (direction: 1 | -1) => by(direction * Math.max(1, height - 2)),
    toEnd: () => {
      setScroll(0);
      setUnseen(0);
    },
  };
}
