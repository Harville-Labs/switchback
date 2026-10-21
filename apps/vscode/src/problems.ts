/** The Problems panel as prompt context, apart from the VS Code API so it's testable. */

export interface Problem {
  /** Workspace-relative path. */
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  source?: string;
}

/** Enough to act on without crowding the prompt; the rest are counted. */
export const MAX_PROBLEMS = 50;

/**
 * Problems as `path:line:col severity: message (source)` lines: the active
 * file's first, then errors before warnings, each in path and line order.
 */
export function problemsText(problems: Problem[], active?: string): string {
  const rank = (p: Problem) => (p.path === active ? 0 : 2) + (p.severity === 'error' ? 0 : 1);
  const sorted = [...problems].sort(
    (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  const lines = sorted
    .slice(0, MAX_PROBLEMS)
    .map(
      (p) =>
        `${p.path}:${p.line}:${p.column} ${p.severity}: ${p.message}${p.source ? ` (${p.source})` : ''}`,
    );
  const more = sorted.length - lines.length;
  if (more > 0) lines.push(`… and ${more} more`);
  return lines.join('\n');
}
