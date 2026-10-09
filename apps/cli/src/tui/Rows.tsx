/** Transcript rows: one per view item (runs of exploring fold into one), plus running subagents. */
import {
  type DisplayRow,
  exploreSummary,
  formatReasoning,
  imageLabel,
  isQuietTool,
  reviewLines,
  speedLabel,
  tailLines,
  toolResult,
  toolTitle,
  type ViewItem,
  type ViewState,
  worktreeLabel,
} from '@switchback/client';
import { Box, Text } from 'ink';
import { DiffView } from './Diff.tsx';
import { renderMarkdown } from './markdown.ts';
import { useTheme } from './theme.ts';

type ToolItem = Extract<ViewItem, { kind: 'tool' }>;

/**
 * Route rows that add nothing: any decision that keeps the model already in
 * use, and the first one when it's just the start model (the header names it).
 */
export function quietRoutes(items: ViewItem[]): Set<string> {
  const quiet = new Set<string>();
  let current: string | undefined;
  for (const it of items) {
    if (it.kind !== 'route') continue;
    const first = current === undefined && it.rule === 'default';
    if (first || it.model.model === current) quiet.add(it.id);
    current = it.model.model;
  }
  return quiet;
}

/** Lines of a reasoning preview while it streams; the full text shows once it's done. */
const THINKING_ROWS = 8;
/** Lines of a command's output shown before ctrl+o. */
const OUTPUT_ROWS = 3;
/** Diff lines shown under an edit before ctrl+o. */
const DIFF_ROWS = 16;
/** Calls listed in an "Explored" block before ctrl+o. */
const EXPLORE_ROWS = 5;

/**
 * A model's reasoning: one line, or (ctrl+o) its paragraphs. While it
 * streams, the open view keeps to its last few lines so the screen doesn't
 * jump; finished, it shows everything.
 */
function Thinking({
  text,
  streaming,
  open,
  width,
}: {
  text: string;
  streaming: boolean;
  open: boolean;
  width: number;
}) {
  const t = useTheme();
  const body = formatReasoning(text);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        <Text color={t.thinking}>✻</Text> {streaming ? 'Thinking…' : 'Thought'}
        {open ? '' : ' · ctrl+o to show'}
      </Text>
      {open ? (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor italic>
            {streaming ? tailLines(body, Math.max(20, width - 4), THINKING_ROWS).join('\n') : body}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

/** A running subagent's latest activity, indented under its row (nested for depth 2). */
export function LiveChild({ view, depth }: { view: ViewState; depth: number }) {
  const recent = view.items.filter((i) => i.kind !== 'user' && i.kind !== 'info').slice(-3);
  return (
    <Box flexDirection="column" marginLeft={2 * depth}>
      {recent.map((it) => (
        <Box key={it.id} flexDirection="column">
          {it.kind === 'assistant' ? (
            <Text dimColor wrap="truncate-end">
              {it.text ? it.text.replace(/\s+/g, ' ').slice(-160) : '✻ Thinking…'}
            </Text>
          ) : (
            <Item item={it} width={80} compact />
          )}
          {it.kind === 'subagent' && it.status === 'running' && view.children[it.id] ? (
            <LiveChild view={view.children[it.id] as ViewState} depth={depth + 1} />
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

/** One display row: an item, or a block of exploring calls. */
export function Row({
  row,
  width,
  final = false,
  expanded = false,
}: {
  row: DisplayRow;
  width: number;
  final?: boolean;
  expanded?: boolean;
}) {
  return row.kind === 'explore' ? (
    <Explored calls={row.calls} expanded={expanded} />
  ) : (
    <Item item={row.item} width={width} final={final} expanded={expanded} />
  );
}

/** The `●` that starts a call's row, colored by how it went. */
function Dot({ status }: { status: ToolItem['status'] }) {
  const t = useTheme();
  const color = status === 'running' ? t.warning : status === 'ok' ? t.success : t.error;
  return <Text color={color}>{status === 'running' ? '◐' : '●'}</Text>;
}

/** Lines under a row, hung from `⎿` like a reply under its call. */
function Under({ children, first }: { children: React.ReactNode; first: boolean }) {
  return (
    <Text>
      <Text dimColor>{first ? '  ⎿  ' : '     '}</Text>
      {children}
    </Text>
  );
}

function ToolRow({
  item,
  width,
  expanded,
  compact,
}: {
  item: ToolItem;
  width: number;
  expanded: boolean;
  compact: boolean;
}) {
  const t = useTheme();
  const title = toolTitle(item.name, item.input);
  const result = toolResult(item, expanded ? Number.POSITIVE_INFINITY : OUTPUT_ROWS);
  const target = title.target.replace(/\s+/g, ' ');
  const lines: React.ReactNode[] = [];
  if (result.summary)
    lines.push(
      <Text
        color={result.tone === 'error' ? t.error : undefined}
        dimColor={result.tone !== 'error'}
      >
        {result.summary}
      </Text>,
    );
  for (const line of result.body) lines.push(<Text dimColor>{line}</Text>);
  if (result.more) lines.push(<Text dimColor>… +{result.more} lines (ctrl+o to expand)</Text>);
  return (
    <Box flexDirection="column" marginTop={compact ? 0 : 1}>
      <Text wrap="truncate-end">
        <Dot status={item.status} /> <Text bold>{title.verb}</Text>
        {target ? <Text> {target}</Text> : null}
        {item.private ? <Text color={t.accent}> 🔒 stays local</Text> : null}
      </Text>
      {compact
        ? null
        : lines.map((node, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a finished call
            <Box key={i}>
              <Under first={i === 0}>{node}</Under>
            </Box>
          ))}
      {!compact && item.diff && item.status === 'ok' ? (
        <Box marginTop={0}>
          <DiffView
            diff={item.diff}
            maxLines={expanded ? Number.POSITIVE_INFINITY : DIFF_ROWS}
            width={width}
            indent={5}
          />
        </Box>
      ) : null}
    </Box>
  );
}

/** Reading and searching, folded into one block: what was looked at, and what turned up. */
function Explored({ calls, expanded }: { calls: ToolItem[]; expanded: boolean }) {
  const running = calls.some((c) => c.status === 'running');
  const shown = expanded ? calls : calls.slice(-EXPLORE_ROWS);
  const hidden = calls.length - shown.length;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Dot status={running ? 'running' : 'ok'} />{' '}
        <Text bold>{running ? 'Exploring' : 'Explored'}</Text>
        <Text dimColor> · {exploreSummary(calls)}</Text>
      </Text>
      {hidden > 0 ? (
        <Under first>
          <Text dimColor>… {hidden} earlier (ctrl+o to expand)</Text>
        </Under>
      ) : null}
      {shown.map((c, i) => {
        const title = toolTitle(c.name, c.input);
        const summary = toolResult(c).summary;
        return (
          <Under key={c.id} first={i === 0 && hidden === 0}>
            <Text>{title.verb} </Text>
            <Text>{title.target}</Text>
            {summary ? <Text dimColor> · {summary}</Text> : null}
          </Under>
        );
      })}
    </Box>
  );
}

export function Item({
  item,
  width,
  final = false,
  expanded = false,
  compact = false,
}: {
  item: ViewItem;
  width: number;
  /** Committed items render Markdown; live ones stay plain while streaming. */
  final?: boolean;
  /** ctrl+o: reasoning, output, and diffs in full. */
  expanded?: boolean;
  /** Just the title line (a subagent's activity). */
  compact?: boolean;
}) {
  const t = useTheme();
  if (item.kind === 'tool' && isQuietTool(item.name)) return null;
  // A subagent's own row tells its story; its task call only matters if it failed.
  if (item.kind === 'tool' && item.name === 'task' && item.status !== 'error') return null;
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={t.accent} bold>
            {'› '}
          </Text>
          <Box flexShrink={1}>
            <Text bold>{item.text}</Text>
          </Box>
        </Box>
      );
    case 'image':
      return <Text dimColor>{`  ${imageLabel(item.name)}`}</Text>;
    case 'info':
      return (
        <Box marginTop={1}>
          <Text dimColor>{item.text}</Text>
        </Box>
      );
    case 'route': {
      const color = item.tier === 'local' ? t.local : t.remote;
      return (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            <Text color={color}>
              {item.tier === 'local' ? '⌂' : '☁'} {item.model.model}
            </Text>{' '}
            · {item.reason}
            {item.tokensPerSecond !== undefined ? ` · ${speedLabel(item.tokensPerSecond)}` : ''}
          </Text>
        </Box>
      );
    }
    case 'assistant':
      return (
        <Box flexDirection="column">
          {item.reasoning ? (
            <Thinking
              text={item.reasoning}
              streaming={!final && !item.text}
              open={expanded}
              width={width}
            />
          ) : null}
          {item.text ? (
            <Box marginTop={1}>
              <Text>● </Text>
              <Box flexDirection="column" flexShrink={1}>
                <Text>{final ? renderMarkdown(item.text, width - 2) : item.text}</Text>
              </Box>
            </Box>
          ) : null}
        </Box>
      );
    case 'tool':
      return <ToolRow item={item} width={width} expanded={expanded} compact={compact} />;
    case 'subagent': {
      const icon = item.status === 'running' ? '◌' : item.status === 'ok' ? '✓' : '✗';
      return (
        <Box marginTop={compact ? 0 : 1} flexDirection="column">
          <Text>
            <Text color={t.thinking}>
              {icon} {item.agent}
            </Text>{' '}
            {item.task}
            <Text dimColor>
              {item.background ? ' · background' : ''}
              {item.tier ? ` · ${item.tier}` : ''} · {item.toolCalls} tool calls
              {item.status === 'running' && item.activity ? ` · ${item.activity}` : ''}
            </Text>
          </Text>
          {item.worktree ? <Text dimColor>{`  ${worktreeLabel(item.worktree)}`}</Text> : null}
        </Box>
      );
    }
    case 'review': {
      const [head, ...issues] = reviewLines(item);
      const color =
        item.verdict === 'approve' ? t.success : item.verdict === 'revise' ? t.warning : undefined;
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color} dimColor={item.verdict === 'skipped'}>
            {head}
          </Text>
          {issues.map((line) => (
            <Text key={line} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      );
    }
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color={t.error}>
            ✗ <Text bold>error</Text> {item.message}
          </Text>
        </Box>
      );
  }
}
