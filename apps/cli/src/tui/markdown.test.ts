import { expect, test } from 'bun:test';
import { renderMarkdown } from './markdown.ts';

const strip = (s: string) => Bun.stripANSI(s);

test('renders Markdown and wraps prose to the width', () => {
  const text = `**Summary**: ${'the retry logic lives in the http client and backs off exponentially '.repeat(3)}\n\n- one\n- two\n\n\`\`\`ts\nconst x = 1;\n\`\`\``;
  const out = strip(renderMarkdown(text, 50));
  expect(out).not.toContain('**');
  expect(out).not.toContain('```');
  expect(out).toContain('const x = 1;');
  for (const line of out.split('\n')) expect(line.length).toBeLessThanOrEqual(52);
});
