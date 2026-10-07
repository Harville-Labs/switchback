import { expect, test } from 'bun:test';
import { Terminal } from '@xterm/headless';
import { terminalSvg } from './terminal-svg.ts';

async function screen(data: string): Promise<Terminal> {
  const term = new Terminal({ cols: 20, rows: 2, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(data, resolve));
  return term;
}

test('styled runs keep their color and weight, and markup in the text is escaped', async () => {
  const svg = terminalSvg(await screen('\x1b[1;31m<ok>\x1b[0m & done'), 'A test screen');
  expect(svg).toContain('aria-label="A test screen"');
  expect(svg).toMatch(/fill="#e06c75"[^>]*font-weight="bold"[^>]*>&lt;<\/text>/);
  expect(svg).toContain('&amp;</text>');
});

test('a truecolor background becomes a rectangle under its cells', async () => {
  const svg = terminalSvg(await screen('\x1b[48;2;18;52;86m  x \x1b[0m'), 'Background');
  expect(svg).toMatch(/<rect x="20" y="20" width="33\.6" height="18" fill="#123456"\/>/);
});

test('text stays at terminal cell positions without stretching a styled run', async () => {
  const svg = terminalSvg(await screen('Short label'), 'Cells');
  expect(svg).not.toContain('textLength=');
  expect(svg).toContain('x="20" y="33"');
  expect(svg).toContain('x="28.4" y="33"');
});
