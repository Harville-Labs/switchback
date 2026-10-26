/**
 * Color for what slash commands print into the transcript. Commands hand back
 * plain text (VS Code shows the same strings); this reads its shapes — a title
 * line, `name: value` rows, ✓/✗ markers, `/commands`, `@mentions` — and styles
 * them so a long listing like `/mcp` or `/help` scans at a glance.
 */
import { Text } from 'ink';
import { type Theme, useTheme } from './theme.ts';

export type Role = 'heading' | 'label' | 'code' | 'ref' | 'ok' | 'bad' | 'off' | 'money' | 'dim';

export interface Piece {
  text: string;
  role?: Role;
}

const TOKEN = new RegExp(
  [
    '(?<label>^\\s*(?:\\d+\\.\\s+)?[\\w.@/-]+(?=:\\s))',
    '(?<code>`[^`]+`)',
    '(?<ref>@[\\w-]+:\\S+)',
    '(?<cmd>(?<![\\w/.-])/[a-z][\\w:-]*(?=[\\s,.;)]|$))',
    '(?<paren>\\([^)]*\\))',
    '(?<money>\\$\\d[\\d,.]*)',
    '(?<ok>\\b(?:connected|healthy|running|done|completed)\\b)',
    '(?<bad>\\b(?:failed|error|errored|disconnected|unreachable|denied|killed)\\b)',
    '(?<off>\\b(?:disabled|idle|stopped|pending)\\b)',
  ].join('|'),
  'gi',
);

const MARKS: Record<string, Role> = { '✓': 'ok', '✔': 'ok', '✗': 'bad', '✘': 'bad', '-': 'off' };

/** A title: the first line of a listing, short and not a sentence. */
const isHeading = (line: string, index: number, count: number) =>
  (index === 0 && count > 1 && /^[A-Z][^.:!?]{0,40}$/.test(line)) || /^── .+ ──$/.test(line);

/** One line as styled pieces; the text of all pieces joins back to the line. */
export function styleInfoLine(line: string, index = 0, count = 1): Piece[] {
  if (isHeading(line, index, count)) return [{ text: line, role: 'heading' }];
  const out: Piece[] = [];
  const mark = /^(\s*)([✓✔✗✘-])(\s)/.exec(line);
  const role = mark?.[2] ? MARKS[mark[2]] : undefined;
  if (mark && role) {
    out.push({ text: mark[1] ?? '' }, { text: mark[2] ?? '', role }, { text: mark[3] ?? '' });
  }
  const rest = mark && role ? line.slice(mark[0].length) : line;
  let at = 0;
  for (const m of rest.matchAll(TOKEN)) {
    if (m.index > at) out.push({ text: rest.slice(at, m.index) });
    const kind = Object.entries(m.groups ?? {}).find(([, v]) => v !== undefined)?.[0];
    const map: Record<string, Role> = {
      label: 'label',
      code: 'code',
      ref: 'ref',
      cmd: 'code',
      paren: 'dim',
      money: 'money',
      ok: 'ok',
      bad: 'bad',
      off: 'off',
    };
    out.push({ text: m[0], role: kind ? map[kind] : undefined });
    at = m.index + m[0].length;
  }
  if (at < rest.length) out.push({ text: rest.slice(at) });
  return out;
}

/** The pieces of a whole message, one array per line. */
export function styleInfo(text: string): Piece[][] {
  const lines = text.split('\n');
  return lines.map((l, i) => styleInfoLine(l, i, lines.length));
}

function props(role: Role | undefined, t: Theme): Record<string, unknown> {
  switch (role) {
    case 'heading':
      return { bold: true, color: t.brand };
    case 'label':
      return { bold: true };
    case 'code':
    case 'ref':
      return { color: t.accent };
    case 'ok':
      return { color: t.success };
    case 'bad':
      return { color: t.error };
    case 'money':
      return { color: t.remote };
    case 'off':
    case 'dim':
      return { dimColor: true };
    default:
      return {};
  }
}

export function InfoText({ text }: { text: string }) {
  const t = useTheme();
  return (
    <Text>
      {styleInfo(text).map((pieces, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond position
        <Text key={i}>
          {i ? '\n' : ''}
          {pieces.map((p, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: pieces are positional too
            <Text key={j} {...props(p.role, t)}>
              {p.text}
            </Text>
          ))}
        </Text>
      ))}
    </Text>
  );
}
