/** A unified diff as people read one: line numbers, and tinted bands for what changed. */
import { Box, Text } from 'ink';
import { useTheme } from './theme.ts';

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'gap';
  /** The new file's line number for added and unchanged lines, the old file's for removed ones. */
  number?: number;
  text: string;
}

/** The diff's lines, numbered from its hunk headers; file headers are dropped. */
export function diffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\')) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (out.length) out.push({ kind: 'gap', text: '⋮' });
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('+')) out.push({ kind: 'add', number: newLine++, text: line.slice(1) });
    else if (line.startsWith('-'))
      out.push({ kind: 'remove', number: oldLine++, text: line.slice(1) });
    else if (line.startsWith(' ')) {
      out.push({ kind: 'context', number: newLine++, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith('…')) out.push({ kind: 'gap', text: line });
  }
  return out;
}

export function DiffView({
  diff,
  maxLines,
  width,
  indent = 0,
}: {
  diff: string;
  maxLines: number;
  width: number;
  indent?: number;
}) {
  const t = useTheme();
  const lines = diffLines(diff);
  const shown = lines.slice(0, maxLines);
  const gutter = Math.max(3, ...shown.map((l) => String(l.number ?? '').length));
  // Bands run the full width, so changed lines read as blocks.
  const room = Math.max(10, width - indent - gutter - 3);
  return (
    <Box flexDirection="column" marginLeft={indent}>
      {shown.map((l, i) => {
        if (l.kind === 'gap')
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff
            <Text key={i} dimColor>
              {' '.repeat(gutter)} {l.text}
            </Text>
          );
        const sign = l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ';
        const body = `${sign} ${l.text.replaceAll('\t', '  ')}`;
        const text = body.length > room ? `${body.slice(0, room - 1)}…` : body.padEnd(room);
        const changed = l.kind !== 'context';
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed diff
          <Text key={i}>
            <Text dimColor>{String(l.number ?? '').padStart(gutter)} </Text>
            <Text
              color={l.kind === 'add' ? t.added : l.kind === 'remove' ? t.removed : undefined}
              {...(l.kind === 'add' && t.addedBg ? { backgroundColor: t.addedBg } : {})}
              {...(l.kind === 'remove' && t.removedBg ? { backgroundColor: t.removedBg } : {})}
              dimColor={!changed}
              bold={changed && t.name === 'plain'}
            >
              {text}
            </Text>
          </Text>
        );
      })}
      {lines.length > shown.length ? (
        <Text dimColor>
          {' '.repeat(gutter)} … {lines.length - shown.length} more lines (ctrl+o to expand)
        </Text>
      ) : null}
    </Box>
  );
}
