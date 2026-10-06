/** Transcript rows: one per view item, plus the live view of running subagents. */
import {
  formatReasoning,
  isQuietTool,
  reviewLines,
  tailLines,
  toolLabel,
  type ViewItem,
  type ViewState,
} from '@switchback/client';
import { Box, Text } from 'ink';
import { renderMarkdown } from './markdown.ts';

/** Route rows that add nothing: a default/sticky decision for the model already in use. */
export function quietRoutes(items: ViewItem[]): Set<string> {
  const quiet = new Set<string>();
  let current: string | undefined;
  for (const it of items) {
    if (it.kind !== 'route') continue;
    if (['default', 'sticky', 'history'].includes(it.rule) && it.model.model === current)
      quiet.add(it.id);
    current = it.model.model;
  }
  return quiet;
}

/** Lines of a reasoning preview while it streams; the full text shows once it's done. */
const THINKING_ROWS = 8;

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
  hint,
}: {
  text: string;
  streaming: boolean;
  open: boolean;
  width: number;
  /** Mention the key: only on live rows, which it can still change. */
  hint: boolean;
}) {
  const label = streaming ? 'Thinking…' : 'Thought';
  const toggle = hint ? ` · ctrl+o to ${open ? 'hide' : 'show'}` : '';
  const body = formatReasoning(text);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor>
        <Text color="magenta">✻</Text> {label}
        {toggle}
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
            <Item item={it} hidden={false} width={80} />
          )}
          {it.kind === 'subagent' && it.status === 'running' && view.children[it.id] ? (
            <LiveChild view={view.children[it.id] as ViewState} depth={depth + 1} />
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function Item({
  item,
  hidden,
  width,
  final = false,
  showThinking = false,
}: {
  item: ViewItem;
  hidden: boolean;
  width: number;
  /** Committed items render Markdown; live ones stay plain while streaming. */
  final?: boolean;
  /** Reasoning in full (ctrl+o) rather than one line. */
  showThinking?: boolean;
}) {
  if (hidden || (item.kind === 'tool' && isQuietTool(item.name))) return null;
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color="cyan">❯ </Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'info':
      return <Text dimColor>{item.text}</Text>;
    case 'route': {
      const color = item.tier === 'local' ? 'green' : 'yellow';
      return (
        <Text dimColor>
          <Text color={color}>{item.tier === 'local' ? '⌂' : '☁'}</Text> {item.model.model} ·{' '}
          {item.reason}
        </Text>
      );
    }
    case 'assistant':
      return (
        <Box flexDirection="column">
          {item.reasoning ? (
            <Thinking
              text={item.reasoning}
              streaming={!final && !item.text}
              open={showThinking}
              width={width}
              hint={!final}
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
    case 'tool': {
      const color = item.status === 'running' ? 'yellow' : item.status === 'ok' ? 'green' : 'red';
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={color}>●</Text> {toolLabel(item.name, item.input)}
            {item.private ? <Text color="cyan"> 🔒 stays local</Text> : null}
          </Text>
          {item.status === 'error' && item.output ? (
            <Text color="red" dimColor wrap="truncate-end">
              {'  ⎿ '}
              {item.output.split('\n')[0]}
            </Text>
          ) : null}
        </Box>
      );
    }
    case 'subagent': {
      const icon = item.status === 'running' ? '◌' : item.status === 'ok' ? '✓' : '✗';
      return (
        <Text>
          <Text color="magenta">
            ↳ {icon} {item.agent}
          </Text>{' '}
          {item.task}
          <Text dimColor>
            {item.background ? ' · background' : ''}
            {item.tier ? ` · ${item.tier}` : ''} · {item.toolCalls} tool calls
            {item.status === 'running' && item.activity ? ` · ${item.activity}` : ''}
          </Text>
        </Text>
      );
    }
    case 'review': {
      const [head, ...issues] = reviewLines(item);
      const color =
        item.verdict === 'approve' ? 'green' : item.verdict === 'revise' ? 'yellow' : undefined;
      return (
        <Box flexDirection="column">
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
        <Text color="red">
          ✗ <Text bold>error</Text> {item.message}
        </Text>
      );
  }
}
