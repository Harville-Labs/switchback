import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { heading, marked, type Style, summary, tildify } from './doctor-style.ts';

/** Styles as tags, so tests read what's styled how. */
const tag =
  (name: string) =>
  (s: string): string =>
    `<${name}>${s}</${name}>`;
const style: Style = {
  bold: tag('b'),
  dim: tag('dim'),
  green: tag('green'),
  red: tag('red'),
  yellow: tag('yellow'),
  cyan: tag('cyan'),
};

test('headings are bold, with an optional dim note', () => {
  expect(heading(style, 'Providers')).toBe('<b><cyan>Providers</cyan></b>');
  expect(heading(style, 'Instructions', 'in every session')).toBe(
    '<b><cyan>Instructions</cyan></b> <dim>in every session</dim>',
  );
});

test('lines are colored by their mark, keeping their indent', () => {
  expect(marked(style, '  ✓ ollama: 3 models')).toBe('  <green>✓</green> ollama: 3 models');
  expect(marked(style, '    ✗ models.big: not served')).toBe(
    '    <red>✗ models.big: not served</red>',
  );
  expect(marked(style, '  ! instructions are large')).toBe(
    '  <yellow>! instructions are large</yellow>',
  );
  expect(marked(style, '  - spare (openai): not used by any model')).toBe(
    '<dim>  - spare (openai): not used by any model</dim>',
  );
  expect(marked(style, '  escalation auto')).toBe('  escalation auto');
  // A mark has to start the line's text.
  expect(marked(style, '  a ✗ b')).toBe('  a ✗ b');
});

test('the summary says all good, or how many problems', () => {
  expect(summary(style, 0)).toBe('<b><green>✓ All good.</green></b>');
  expect(summary(style, 1)).toBe('<b><red>✗ 1 problem found.</red></b>');
  expect(summary(style, 3)).toBe('<b><red>✗ 3 problems found.</red></b>');
});

test('paths under the home directory are shown from ~', () => {
  const home = join('/', 'home', 'me');
  expect(tildify(join(home, '.switchback', 'config.json'), home)).toBe(
    join('~', '.switchback', 'config.json'),
  );
  expect(tildify(join('/', 'home', 'meg', 'x'), home)).toBe(join('/', 'home', 'meg', 'x'));
  expect(tildify(home, home)).toBe('~');
});
