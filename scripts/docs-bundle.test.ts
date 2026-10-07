import { expect, test } from 'bun:test';
import { buildBundle, plainSummary, rewriteLink, userPages } from './docs-bundle.ts';

test('the published docs are the user pages, and every link between them lands on a heading', () => {
  const { pages } = buildBundle('9.9.9');
  const slugs = pages.map((p) => p.slug);
  expect(slugs).toContain('configuration');
  expect(slugs).toContain('clients/tui');
  // Internal pages stay on GitHub.
  for (const internal of ['architecture', 'protocol', 'roadmap'])
    expect(slugs).not.toContain(internal);
  expect(slugs.some((s) => s.startsWith('adr/'))).toBe(false);

  const ids = new Map(pages.map((p) => [p.slug, new Set(p.headings.map((h) => h.id))]));
  const broken: string[] = [];
  for (const p of pages) {
    for (const [, slug = '', anchor] of p.html.matchAll(/href="docs:([^"#]+)(?:#([^"]+))?"/g)) {
      if (!ids.has(slug)) broken.push(`${p.slug} → ${slug} (not published)`);
      else if (anchor && !ids.get(slug)?.has(anchor)) broken.push(`${p.slug} → ${slug}#${anchor}`);
    }
    for (const [, anchor = ''] of p.html.matchAll(/href="#([^"]+)"/g))
      if (!ids.get(p.slug)?.has(anchor)) broken.push(`${p.slug} → #${anchor}`);
  }
  expect(broken).toEqual([]);
});

test('links resolve relative to the page they are on', () => {
  const included = new Set(['configuration', 'clients/tui']);
  expect(rewriteLink('../configuration.md#keys', 'clients/tui', included, '1.0.0')).toBe(
    'docs:configuration#keys',
  );
  expect(rewriteLink('adr/0006-provider-neutrality.md', 'routing', included, '1.0.0')).toBe(
    'https://github.com/Harville-Labs/switchback/blob/v1.0.0/docs/adr/0006-provider-neutrality.md',
  );
  expect(rewriteLink('../AGENTS.md', 'routing', included, '1.0.0')).toBe(
    'https://github.com/Harville-Labs/switchback/blob/v1.0.0/AGENTS.md',
  );
  expect(rewriteLink('assets/x.png', 'routing', included, '1.0.0', true)).toBe(
    'https://raw.githubusercontent.com/Harville-Labs/switchback/v1.0.0/docs/assets/x.png',
  );
  expect(rewriteLink('https://example.com', 'routing', included, '1.0.0')).toBe(
    'https://example.com',
  );
  expect(
    userPages('## Using Switchback\n- [A](a.md): first\n- [B](b.md) · [C](c/d.md)\n## Building\n'),
  ).toEqual([
    { slug: 'a', summary: 'first' },
    { slug: 'b', summary: '' },
    { slug: 'c/d', summary: '' },
  ]);
});

test('card summaries are plain text', () => {
  expect(plainSummary('your own `/commands`, and **skills**')).toBe(
    'Your own /commands, and skills',
  );
});
