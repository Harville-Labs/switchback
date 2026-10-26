import { describe, expect, test } from 'bun:test';
import { styleInfo, styleInfoLine } from './info.tsx';

const roles = (line: string) =>
  styleInfoLine(line, 1, 3)
    .filter((p) => p.role)
    .map((p) => [p.text, p.role]);

describe('styleInfo', () => {
  test('pieces join back to the original text', () => {
    const text = 'MCP servers\n  ✓ fs: connected, 3 tools (stdio)\n      @fs:file:///a  a file';
    expect(
      styleInfo(text)
        .map((l) => l.map((p) => p.text).join(''))
        .join('\n'),
    ).toBe(text);
  });

  test('the first line of a listing is a heading, a sentence is not', () => {
    expect(styleInfoLine('MCP servers', 0, 4)[0]?.role).toBe('heading');
    expect(styleInfoLine('Switched to fast.', 0, 1)[0]?.role).toBeUndefined();
    expect(styleInfoLine('No servers configured', 0, 1)[0]?.role).toBeUndefined();
  });

  test('a connected server row colors its marker, name, and state', () => {
    expect(roles('  ✓ fs: connected, 3 tools')).toEqual([
      ['✓', 'ok'],
      ['fs', 'label'],
      ['connected', 'ok'],
    ]);
  });

  test('a failed server row is marked as an error', () => {
    expect(roles('  ✗ db: failed (spawn ENOENT)')).toEqual([
      ['✗', 'bad'],
      ['db', 'label'],
      ['failed', 'bad'],
      ['(spawn ENOENT)', 'dim'],
    ]);
  });

  test('slash commands and mentions are highlighted but file paths are not', () => {
    expect(roles('try /help or @fs:thing')).toEqual([
      ['/help', 'code'],
      ['@fs:thing', 'ref'],
    ]);
    expect(roles('see /usr/bin/env')).toEqual([]);
  });
});
