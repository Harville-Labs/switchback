/**
 * How `switchback doctor` reads in a terminal: section headings stand out,
 * ✓ is green, ✗ red, ! yellow, and details step back. Pure, so the shared
 * formatters' plain text (format.ts, also drawn by the TUI) can be marked up
 * here without teaching them about terminals.
 */
import { sep } from 'node:path';

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  green(s: string): string;
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

/** A section heading, with an optional note after it. */
export function heading(style: Style, title: string, note?: string): string {
  return `${style.bold(style.cyan(title))}${note ? ` ${style.dim(note)}` : ''}`;
}

/**
 * Color a line by its mark: `✓` green, a `✗` line red, a `!` line yellow,
 * and a `-` line (something configured but unused) dimmed. Other lines pass
 * through.
 */
export function marked(style: Style, line: string): string {
  const m = /^(\s*)(✓|✗|!|-) (.*)$/.exec(line);
  if (!m) return line;
  const [, indent = '', mark, rest = ''] = m;
  switch (mark) {
    case '✓':
      return `${indent}${style.green('✓')} ${rest}`;
    case '✗':
      return `${indent}${style.red(`✗ ${rest}`)}`;
    case '!':
      return `${indent}${style.yellow(`! ${rest}`)}`;
    default:
      return style.dim(line);
  }
}

/** A path under the home directory as `~/...`, the way the docs write it; others as they are. */
export function tildify(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(`${home}${sep}`) ? `~${sep}${path.slice(home.length + 1)}` : path;
}

/** The last line: all good, or how many problems. */
export function summary(style: Style, problems: number): string {
  return problems
    ? style.bold(style.red(`✗ ${problems} problem${problems === 1 ? '' : 's'} found.`))
    : style.bold(style.green('✓ All good.'));
}
