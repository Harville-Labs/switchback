import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DOCS_TOPICS, docsSection, EMBEDDED_DOCS, userPages } from '../docs.ts';
import { docsTool } from './docs.ts';
import type { ToolContext } from './tool.ts';

const docsFile = (slug: string) =>
  readFileSync(new URL(`../../../../docs/${slug}.md`, import.meta.url), 'utf8');

const ctx: ToolContext = {
  workspaceRoot: '/work',
  sessionId: 's',
  signal: new AbortController().signal,
  agentCatalog: [],
  configFiles: {
    user: '/home/me/.switchback/config.json',
    project: '/work/.switchback/config.json',
    projectLocal: '/work/.switchback/config.local.json',
  },
};

describe('embedded docs', () => {
  test('are exactly the pages the index lists for users, as they are on disk', () => {
    const listed = userPages(docsFile('README')).map((p) => p.slug);
    expect(Object.keys(EMBEDDED_DOCS).sort()).toEqual([...listed].sort());
    expect(DOCS_TOPICS.map((t) => t.slug)).toEqual(listed);
    for (const slug of listed) expect(EMBEDDED_DOCS[slug]).toBe(docsFile(slug));
  });

  test('a section runs from its heading to the next heading at the same depth', () => {
    const page = '# T\n\n## One\na\n### Sub\nb\n## Two\nc\n';
    expect(docsSection(page, 'one')).toBe('## One\na\n### Sub\nb');
    expect(docsSection(page, 'Two')).toBe('## Two\nc');
    expect(docsSection(page, 'three')).toBeUndefined();
  });

  test('a shell comment inside a code block is not a heading', () => {
    const page = '## Setup\n```sh\n# Install\nrun it\n```\nmore\n## Next\n';
    expect(docsSection(page, 'setup')).toBe('## Setup\n```sh\n# Install\nrun it\n```\nmore');
    expect(docsSection(page, 'install')).toBeUndefined();
  });
});

describe('docs tool', () => {
  test('with no topic, lists the topics with their summaries', async () => {
    const out = await docsTool.run({}, ctx);
    expect(out).toContain('- configuration: Configuration: every config key');
    expect(out).toContain('- permissions: Permissions and safety\n');
  });

  test('the configuration page starts with where the config files are on this machine', async () => {
    const out = String(await docsTool.run({ topic: 'configuration' }, ctx));
    expect(out).toContain('/work/.switchback/config.json');
    expect(out).toContain('/work/.switchback/config.local.json');
    expect(out).toMatch(/\/home\/me\/\.switchback\/config\.json\. It's outside the workspace/);
    expect(out).toContain('# Configuration reference');
  });

  test('reads one section of a page', async () => {
    const out = String(await docsTool.run({ topic: 'tools.md', section: 'checklist' }, ctx));
    expect(out.startsWith('## The checklist')).toBe(true);
    expect(out).not.toContain('| `read` |');
  });

  test('an unknown topic or section says what there is', async () => {
    await expect(docsTool.run({ topic: 'architecture' }, ctx)).rejects.toThrow(
      /no docs topic "architecture"\. Topics:\n- configuration: /,
    );
    await expect(docsTool.run({ topic: 'tools', section: 'nope' }, ctx)).rejects.toThrow(
      /no heading in tools matches "nope"\. Its sections:\n- Asking about Switchback\n- The checklist/,
    );
  });
});
