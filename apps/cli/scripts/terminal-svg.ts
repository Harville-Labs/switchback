/**
 * Renders the visible screen of an @xterm/headless terminal as an SVG, for the
 * README screenshots (scripts/screenshots.tsx). SVG rather than PNG: it stays
 * sharp at any zoom, diffs as text, and needs no browser to produce.
 */
import type { IBufferCell, Terminal } from '@xterm/headless';

/** The 16 ANSI colors, as the TUI's dark theme expects them to look. */
const ANSI = [
  '#1d1f21',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#d0d0d0',
  '#5c6370',
  '#ef7b85',
  '#a9d48a',
  '#f0cd8b',
  '#7cc0ff',
  '#d68fea',
  '#6fd1dd',
  '#ffffff',
];
const BACKGROUND = '#16181b';
const FOREGROUND = '#e6e6e6';
const FONT_SIZE = 14;
const CELL_WIDTH = 8.4;
const LINE_HEIGHT = 18;
const PADDING = 20;

function xterm256(n: number): string {
  if (n < 16) return ANSI[n] ?? FOREGROUND;
  if (n >= 232) {
    const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
    return `#${v}${v}${v}`;
  }
  const i = n - 16;
  const level = (c: number) => (c === 0 ? 0 : 55 + c * 40).toString(16).padStart(2, '0');
  return `#${level(Math.floor(i / 36))}${level(Math.floor(i / 6) % 6)}${level(i % 6)}`;
}

function color(cell: IBufferCell, which: 'fg' | 'bg'): string | undefined {
  const fg = which === 'fg';
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return undefined;
  const value = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, '0')}`;
  return xterm256(value);
}

interface Style {
  fg: string;
  bg: string | undefined;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

function styleOf(cell: IBufferCell): Style {
  let fg = color(cell, 'fg') ?? FOREGROUND;
  let bg = color(cell, 'bg');
  if (cell.isInverse()) [fg, bg] = [bg ?? BACKGROUND, fg];
  return {
    fg,
    bg,
    bold: !!cell.isBold(),
    dim: !!cell.isDim(),
    italic: !!cell.isItalic(),
    underline: !!cell.isUnderline(),
  };
}

const sameStyle = (a: Style, b: Style) =>
  a.fg === b.fg &&
  a.bg === b.bg &&
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline;

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The terminal's visible rows as an SVG document, `title` for screen readers. */
export function terminalSvg(term: Terminal, title: string): string {
  const buffer = term.buffer.active;
  const width = term.cols * CELL_WIDTH + PADDING * 2;
  const height = term.rows * LINE_HEIGHT + PADDING * 2;
  const rects: string[] = [];
  const texts: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    if (!line) continue;
    const top = PADDING + y * LINE_HEIGHT;
    let run: { x: number; cells: number; style: Style } | undefined;
    const flush = () => {
      if (!run) return;
      const { x, cells, style } = run;
      const left = PADDING + x * CELL_WIDTH;
      if (style.bg)
        rects.push(
          `<rect x="${left}" y="${top}" width="${cells * CELL_WIDTH}" height="${LINE_HEIGHT}" fill="${style.bg}"/>`,
        );
      run = undefined;
    };
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue; // the second half of a wide character
      const style = styleOf(cell);
      const chars = cell.getChars() || ' ';
      if (chars.trim()) {
        const attrs = [
          `x="${PADDING + x * CELL_WIDTH}"`,
          `y="${top + LINE_HEIGHT - 5}"`,
          `fill="${style.fg}"`,
          style.bold ? 'font-weight="bold"' : '',
          style.dim ? 'opacity="0.6"' : '',
          style.italic ? 'font-style="italic"' : '',
          style.underline ? 'text-decoration="underline"' : '',
        ].filter(Boolean);
        texts.push(`<text ${attrs.join(' ')}>${escapeXml(chars)}</text>`);
      }
      if (run && sameStyle(run.style, style)) {
        run.cells += cell.getWidth();
      } else {
        flush();
        run = { x, cells: cell.getWidth(), style };
      }
    }
    flush();
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${BACKGROUND}"/>`,
    ...rects,
    `<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT_SIZE}" xml:space="preserve">`,
    ...texts,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}
