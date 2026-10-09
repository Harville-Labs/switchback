import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promptOf, stopReasonOf, workspacePath } from './translate.ts';

const root = join('/', 'work', 'app');

test('files in the workspace are attached by path; others are passed along as their URI', () => {
  const inside = pathToFileURL(join(root, 'src', 'main.ts')).href;
  const outside = pathToFileURL(join('/', 'etc', 'hosts')).href;
  expect(
    promptOf(
      [
        { type: 'text', text: 'explain' },
        { type: 'resource_link', name: 'main.ts', uri: inside },
        { type: 'resource_link', name: 'hosts', uri: outside },
        { type: 'resource', resource: { uri: 'zed://selection', text: 'let x = 1' } },
        { type: 'image', mimeType: 'image/png', data: 'iVBOR' },
      ],
      root,
    ),
  ).toEqual({
    text: `explain\n${outside}`,
    attachments: [
      { kind: 'file', path: 'src/main.ts' },
      { kind: 'text', label: 'zed://selection', text: 'let x = 1' },
      { kind: 'image', name: 'image 1', data: 'iVBOR' },
    ],
  });
});

test('a prompt with only attachments still has text for the model', () => {
  const uri = pathToFileURL(join(root, 'a.ts')).href;
  expect(promptOf([{ type: 'resource_link', name: 'a.ts', uri }], root).text).toBe('See a.ts.');
});

test('paths that escape the workspace are not workspace paths', () => {
  expect(workspacePath(join(root, '..', 'other', 'x.ts'), root)).toBeUndefined();
  expect(workspacePath('https://example.com/x', root)).toBeUndefined();
  expect(workspacePath(root, root)).toBeUndefined();
});

test('an error has no ACP stop reason; the request fails instead', () => {
  expect(stopReasonOf('tool_use')).toBe('end_turn');
  expect(stopReasonOf('refusal')).toBe('refusal');
  expect(stopReasonOf('error')).toBeUndefined();
});
