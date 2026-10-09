import { expect, test } from 'bun:test';
import { formatPermissions, permissionWhy } from './format.ts';

test('/permissions groups rules by source and wraps long lists', () => {
  const allow = Array.from({ length: 12 }, (_, i) => `bash(tool${i}:*)`);
  const text = formatPermissions({
    mode: 'default',
    modes: ['default'],
    levels: { read: 'allow', edit: 'ask', bash: 'ask', web: 'ask', mcp: 'ask' },
    sandbox: { active: true },
    rules: [
      { rule: 'read(.env)', behavior: 'deny', source: 'organization' },
      ...allow.map((rule) => ({ rule, behavior: 'allow' as const, source: 'config.json' })),
      { rule: 'bash(git push:*)', behavior: 'ask', source: 'config.json' },
    ],
  } as Parameters<typeof formatPermissions>[0]);
  const lines = text.split('\n');
  expect(lines).toContain('  organization');
  expect(lines).toContain('    deny  read(.env)');
  expect(lines).toContain('    ask   bash(git push:*)');
  const allowLines = lines.slice(lines.indexOf('    ask   bash(git push:*)') + 1);
  expect(allowLines.length).toBeGreaterThan(1);
  expect(allowLines.every((l) => l.length <= 100)).toBe(true);
  expect(allowLines.join(' ')).toContain('bash(tool11:*)');
});

test('a permission prompt says why it asks: an ask rule, or another reason', () => {
  expect(permissionWhy({ askRule: 'bash(git push:*)' })).toBe(
    'The rule bash(git push:*) asks every time.',
  );
  expect(permissionWhy({ reason: 'outside the workspace' })).toBe(
    'Asking because: outside the workspace.',
  );
  expect(permissionWhy({})).toBeUndefined();
});
