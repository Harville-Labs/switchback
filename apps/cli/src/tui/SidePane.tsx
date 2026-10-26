/**
 * The pane beside the transcript on a wide window: how full the context window
 * is, the MCP servers and whether they connected, and what subagents are doing.
 */
import { subagentIcon, subagentList, type ViewState } from '@switchback/client';
import type { McpServerInfo } from '@switchback/protocol';
import { Box, Text } from 'ink';
import { type Theme, useTheme } from './theme.ts';

/** Columns the pane takes, its border included, and the window width it appears from. */
export const SIDE_PANE_WIDTH = 36;
export const SIDE_PANE_MIN_COLUMNS = 110;

const LISTED = 8;

/** `45.2k`, `1.2M`: token counts short enough for a narrow pane. */
export function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** A bar `width` cells wide with `fraction` of it filled. */
export function usageBar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={t.brand}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

function Context({ view, inner }: { view: ViewState; inner: number }) {
  const t = useTheme();
  if (!view.context) return <Text dimColor>nothing sent yet</Text>;
  const { tokens, window } = view.context;
  const used = tokens / window;
  const color = used >= 0.85 ? t.error : used >= 0.7 ? t.warning : t.success;
  return (
    <>
      <Text color={color}>{usageBar(used, inner)}</Text>
      <Text>
        {Math.round(used * 100)}% <Text dimColor>used</Text>
      </Text>
      <Text dimColor>
        {compactCount(tokens)} / {compactCount(window)} tokens
      </Text>
    </>
  );
}

function serverColor(s: McpServerInfo, t: Theme): string | undefined {
  if (s.state === 'connected') return t.success;
  if (s.state === 'failed') return t.error;
  if (s.state === 'untrusted') return t.warning;
  return undefined;
}

function Servers({ servers }: { servers: McpServerInfo[] }) {
  const t = useTheme();
  if (!servers.length) return <Text dimColor>none configured</Text>;
  return (
    <>
      {servers.slice(0, LISTED).map((s) => (
        <Text key={s.name} wrap="truncate-end">
          <Text color={serverColor(s, t)} dimColor={s.state === 'disabled'}>
            ●{' '}
          </Text>
          {s.name}
          <Text dimColor>
            {s.state === 'connected'
              ? ` ${s.tools} tool${s.tools === 1 ? '' : 's'}`
              : s.state === 'untrusted'
                ? ' needs trust'
                : ` ${s.state}`}
          </Text>
        </Text>
      ))}
      {servers.length > LISTED ? <Text dimColor>…and {servers.length - LISTED} more</Text> : null}
    </>
  );
}

function subagentColor(status: string, t: Theme): string | undefined {
  if (status === 'running') return t.brand;
  if (status === 'ok') return t.success;
  if (status === 'error') return t.error;
  return undefined;
}

function Subagents({ view, colors }: { view: ViewState; colors: Record<string, string> }) {
  const t = useTheme();
  const all = subagentList(view);
  if (!all.length) return <Text dimColor>none in this session</Text>;
  // What's still going comes first; a long session's finished ones fall off the end.
  const active = (x: (typeof all)[number]) =>
    Number(x.row.status === 'running' || x.row.status === 'queued');
  const sorted = [...all].sort((a, b) => active(b) - active(a));
  return (
    <>
      {sorted.slice(0, LISTED).map((x) => (
        <Box key={x.id} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color={subagentColor(x.row.status, t)}>{subagentIcon(x.row.status)} </Text>
            <Text bold color={colors[x.row.agent]}>
              {x.row.agent}
            </Text>
          </Text>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {x.row.status === 'running' && x.row.activity ? x.row.activity : x.row.task}
          </Text>
        </Box>
      ))}
      {all.length > LISTED ? <Text dimColor>…and {all.length - LISTED} more</Text> : null}
    </>
  );
}

export function SidePane({
  view,
  servers,
  agentColors = {},
}: {
  view: ViewState;
  servers: McpServerInfo[];
  /** Agent name to `#rrggbb`, for agents that set a color. */
  agentColors?: Record<string, string>;
}) {
  return (
    <Box
      flexDirection="column"
      width={SIDE_PANE_WIDTH}
      flexShrink={0}
      paddingX={1}
      borderStyle="single"
      borderColor="gray"
      borderDimColor
      borderTop={false}
      borderBottom={false}
      borderRight={false}
      overflow="hidden"
    >
      <Section title="Context">
        <Context view={view} inner={SIDE_PANE_WIDTH - 4} />
      </Section>
      <Section title="MCP">
        <Servers servers={servers} />
      </Section>
      <Section title="Subagents">
        <Subagents view={view} colors={agentColors} />
      </Section>
    </Box>
  );
}
