/**
 * The user-facing docs of one release, as a single JSON file the website
 * (harville.ai/switchback/docs) renders: the pages listed under "Using
 * Switchback" in docs/README.md, in that order, rendered to HTML with
 * GitHub's heading anchors. Internal pages (architecture, ADRs, the
 * protocol, the roadmap) aren't included; links to them go to GitHub at the
 * release's tag.
 *
 *   bun scripts/docs-bundle.ts 0.8.0 [out.json]
 *
 * Links between included pages become `docs:<slug>#anchor`, for the website
 * to resolve against the version it shows.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, type Token } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(ROOT, 'docs');
const REPO = 'https://github.com/Harville-Labs/switchback';

export interface DocsPage {
  /** Path under docs/ without `.md`: `configuration`, `clients/tui`. */
  slug: string;
  title: string;
  /** One line, from the index. */
  summary: string;
  html: string;
  /** Plain text, for search. */
  text: string;
  headings: { id: string; text: string; depth: number }[];
}

export interface DocsBundle {
  version: string;
  pages: DocsPage[];
}

/** The pages the index lists for users, in its order, with their one-line summaries. */
export function userPages(index: string): { slug: string; summary: string }[] {
  const section = /## Using Switchback\n([\s\S]*?)\n## /.exec(index)?.[1] ?? '';
  const pages: { slug: string; summary: string }[] = [];
  for (const line of section.split('\n')) {
    // A line can list several pages (`[TUI](clients/tui.md) · [VS Code](clients/vscode.md)`).
    const summary = /\]\([^)]+\.md\):\s*(.*)$/.exec(line)?.[1] ?? '';
    for (const m of line.matchAll(/\]\(([^)#]+)\.md\)/g)) pages.push({ slug: m[1] ?? '', summary });
  }
  return pages;
}

/** Where a link in `from` (a slug) points: another included page, GitHub, or as written. */
export function rewriteLink(
  href: string,
  from: string,
  included: Set<string>,
  version: string,
  image = false,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) return href;
  const [path = '', anchor] = href.split('#');
  const target = normalize(join(dirname(from), path))
    .split('\\')
    .join('/');
  const hash = anchor ? `#${anchor}` : '';
  if (image)
    return `https://raw.githubusercontent.com/Harville-Labs/switchback/v${version}/docs/${target}`;
  if (target.endsWith('.md') && included.has(target.slice(0, -3)))
    return `docs:${target.slice(0, -3)}${hash}`;
  // Outside docs/ (AGENTS.md, a package) or an internal page: the file on GitHub at this release.
  const repoPath = relative(ROOT, join(DOCS, target)).split('\\').join('/');
  return `${REPO}/blob/v${version}/${repoPath}${hash}`;
}

export function buildBundle(version: string): DocsBundle {
  const listed = userPages(readFileSync(join(DOCS, 'README.md'), 'utf8'));
  const included = new Set(listed.map((p) => p.slug));
  const pages = listed.map(({ slug, summary }) => {
    const source = readFileSync(join(DOCS, `${slug}.md`), 'utf8');
    const headings: DocsPage['headings'] = [];
    const marked = new Marked(gfmHeadingId(), {
      walkTokens(token: Token) {
        if (token.type === 'link') token.href = rewriteLink(token.href, slug, included, version);
        if (token.type === 'image')
          token.href = rewriteLink(token.href, slug, included, version, true);
      },
    });
    const html = marked.parse(source, { async: false });
    // Headings with the ids the extension gave them, for the page's outline and search.
    for (const m of html.matchAll(/<h([1-6]) id="([^"]+)">([\s\S]*?)<\/h\1>/g))
      headings.push({ depth: Number(m[1]), id: m[2] ?? '', text: stripTags(m[3] ?? '') });
    const title = headings.find((h) => h.depth === 1)?.text ?? slug;
    return { slug, title, summary: plainSummary(summary), html, text: stripTags(html), headings };
  });
  return { version, pages };
}

/** An index line's summary as plain text for a card: no Markdown, and a capital first letter. */
export function plainSummary(markdown: string): string {
  // Inline markup only, so tags go without leaving a space ("`/commands`," stays together).
  const html = new Marked().parseInline(markdown, { async: false });
  const text = stripTags(html.replace(/<[^>]+>/g, ''));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

if (import.meta.main) {
  const [version, out] = process.argv.slice(2);
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    console.error('usage: bun scripts/docs-bundle.ts <version> [out.json]');
    process.exit(2);
  }
  const bundle = buildBundle(version);
  const file = out ?? `switchback-docs-${version}.json`;
  writeFileSync(file, JSON.stringify(bundle));
  console.log(`${file}: ${bundle.pages.length} pages`);
}
