import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool } from './fs.ts';
import type { ToolContext } from './tool.ts';

let root: string;
let ctx: ToolContext;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'switchback-read-')));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'empty'));
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, '.env'), 'TOKEN=x\n');
  ctx = {
    workspaceRoot: root,
    sessionId: 's',
    signal: new AbortController().signal,
    agentCatalog: [],
    hidden: (file) => file.endsWith('.env'),
  };
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('read on a directory', () => {
  test('lists its entries, folders first, leaving out what deny rules hide', async () => {
    expect(await readTool.run({ path: '.' }, ctx)).toBe('empty/\nsrc/\nREADME.md');
  });

  test('says so when the directory is empty', async () => {
    expect(await readTool.run({ path: 'empty' }, ctx)).toBe('(empty directory)');
  });
});
