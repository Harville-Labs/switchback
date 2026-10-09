/// <reference path="./markdown.d.ts" />
/**
 * Switchback's user docs, built into the engine so the `docs` tool answers
 * from the documentation of the version that's running, offline. The pages
 * are the ones the index lists under "Using Switchback", the same set the
 * website publishes (scripts/docs-bundle.ts). Imports have to be static for
 * the compiled binary to embed them, so a test checks they match the index.
 */

import headless from '../../../docs/clients/headless.md' with { type: 'text' };
import tui from '../../../docs/clients/tui.md' with { type: 'text' };
import vscode from '../../../docs/clients/vscode.md' with { type: 'text' };
import commandsAndSkills from '../../../docs/commands-and-skills.md' with { type: 'text' };
import configuration from '../../../docs/configuration.md' with { type: 'text' };
import hooks from '../../../docs/hooks.md' with { type: 'text' };
import organizations from '../../../docs/organizations.md' with { type: 'text' };
import permissions from '../../../docs/permissions.md' with { type: 'text' };
import privacy from '../../../docs/privacy.md' with { type: 'text' };
import providers from '../../../docs/providers.md' with { type: 'text' };
import index from '../../../docs/README.md' with { type: 'text' };
import review from '../../../docs/review.md' with { type: 'text' };
import routing from '../../../docs/routing.md' with { type: 'text' };
import sites from '../../../docs/sites.md' with { type: 'text' };
import subagents from '../../../docs/subagents.md' with { type: 'text' };
import telemetry from '../../../docs/telemetry.md' with { type: 'text' };
import tools from '../../../docs/tools.md' with { type: 'text' };

/** Every embedded page, by slug (its path under docs/ without `.md`). */
export const EMBEDDED_DOCS: Record<string, string> = {
  configuration,
  providers,
  routing,
  tools,
  subagents,
  permissions,
  privacy,
  review,
  telemetry,
  'commands-and-skills': commandsAndSkills,
  hooks,
  organizations,
  sites,
  'clients/tui': tui,
  'clients/vscode': vscode,
  'clients/headless': headless,
};

export interface DocsTopic {
  /** Path under docs/ without `.md`: `configuration`, `clients/tui`. */
  slug: string;
  /** The link text in the index: `Permissions and safety`. */
  title: string;
  /** One line, from the index; empty for some pages. */
  summary: string;
}

/** The pages the index lists for users, in its order, with their one-line summaries. */
export function userPages(index: string): DocsTopic[] {
  const section = /## Using Switchback\r?\n([\s\S]*?)\r?\n## /.exec(index)?.[1] ?? '';
  const pages: DocsTopic[] = [];
  for (const line of section.split(/\r?\n/)) {
    // A line can list several pages (`[TUI](clients/tui.md) · [VS Code](clients/vscode.md)`).
    const summary = /\]\([^)]+\.md\):\s*(.*)$/.exec(line)?.[1] ?? '';
    for (const m of line.matchAll(/\[([^\]]+)\]\(([^)#]+)\.md\)/g))
      pages.push({ slug: m[2] ?? '', title: m[1] ?? '', summary });
  }
  return pages;
}

/** The embedded pages, in the index's order. */
export const DOCS_TOPICS: DocsTopic[] = userPages(index).filter((p) => p.slug in EMBEDDED_DOCS);

/**
 * One section of a page: the first heading whose text contains `heading`
 * (ignoring case), through to the next heading at the same depth or above.
 * Undefined when no heading matches.
 */
export function docsSection(page: string, heading: string): string | undefined {
  const lines = page.split(/\r?\n/);
  const want = heading.trim().toLowerCase();
  let fence = false;
  let start = -1;
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    // `#` inside a code block (shell comments) isn't a heading.
    if (line.startsWith('```')) fence = !fence;
    const m = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const level = m[1]?.length ?? 0;
    if (start < 0) {
      if (m[2]?.toLowerCase().includes(want)) {
        start = i;
        depth = level;
      }
    } else if (level <= depth) {
      return lines.slice(start, i).join('\n').trimEnd();
    }
  }
  return start < 0 ? undefined : lines.slice(start).join('\n').trimEnd();
}

/** A page's headings, for suggesting sections when one isn't found. */
export function docsHeadings(page: string): string[] {
  let fence = false;
  const headings: string[] = [];
  for (const line of page.split(/\r?\n/)) {
    if (line.startsWith('```')) fence = !fence;
    const m = fence ? null : /^#{2,3}\s+(.*)$/.exec(line);
    if (m?.[1]) headings.push(m[1]);
  }
  return headings;
}
