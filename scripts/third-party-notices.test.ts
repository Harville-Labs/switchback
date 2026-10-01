import { describe, expect, test } from 'bun:test';
import { collect, packageRoot, render } from './third-party-notices.ts';

describe('packageRoot', () => {
  test('finds the innermost package, scoped or not', () => {
    expect(packageRoot('node_modules/.bun/ink@7.1.1+ab/node_modules/ink/build/a.js')).toBe(
      'node_modules/.bun/ink@7.1.1+ab/node_modules/ink',
    );
    expect(packageRoot('node_modules/@scope/pkg/lib/x.js')).toBe('node_modules/@scope/pkg');
    expect(packageRoot('packages/engine/src/index.ts')).toBeUndefined();
  });
});

test('render lists each package with its license text', () => {
  const out = render([
    { name: 'a', version: '1.0.0', license: 'MIT', text: 'MIT text' },
    { name: 'b', version: '2.0.0', license: 'ISC', text: '' },
  ]);
  expect(out).toContain('a 1.0.0 (MIT)\n\nMIT text');
  expect(out).toContain('b 2.0.0 (ISC)\n\nLicense: ISC');
});

test('the real bundles: every shipped package is listed with a license', async () => {
  const notices = await collect();
  const names = notices.map((n) => n.name);
  expect(names).toContain('ink');
  expect(names).toContain('zod');
  expect(names.some((n) => n.startsWith('@switchback/'))).toBe(false);
  for (const n of notices) expect(n.license || n.text).toBeTruthy();
}, 60_000);
