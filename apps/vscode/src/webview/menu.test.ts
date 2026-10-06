import { expect, test } from 'bun:test';
import { matchCommands } from '@switchback/client/commands';
import { renderMenu } from './menu.ts';

test('the menu groups rows and marks the active one', () => {
  const html = renderMenu(matchCommands('', 'vscode'), 1);
  expect(html.indexOf('>Routing<')).toBeLessThan(html.indexOf('>Session<'));
  expect(html.match(/menu-item active/g)).toHaveLength(1);
  expect(html).toContain('data-cmd="local"');
  expect(renderMenu([], 0)).toContain('No matching commands');
});
