import { describe, expect, test } from 'bun:test';
import stringWidth from 'string-width';
import {
  autoCompactLabel,
  effortNotice,
  estimateLabel,
  formatAgents,
  modeIcon,
  parseAutoCompact,
  parseEffort,
  permissionWhy,
  sessionEffort,
  tierIcon,
} from './format.ts';
import { formatModes, formatPermissions } from './modes.ts';

test('/mode lines up descriptions after the longest mode name and marks the current one', () => {
  const lines = formatModes(['default', 'plan', 'bypassPermissions'], 'plan').split('\n');
  expect(lines.slice(0, 3)).toEqual([
    '  default             ask before edits and commands, as the permission levels say',
    '● plan                read and plan only; nothing changes until you approve the plan',
    '  bypass permissions  everything goes ahead without asking; only deny rules stop a call',
  ]);
});

test('/permissions lines up its labels', () => {
  const text = formatPermissions({
    mode: 'default',
    modes: ['default'],
    levels: { read: 'allow', edit: 'ask', bash: 'ask', web: 'ask', websearch: 'allow', mcp: 'ask' },
    sandbox: { active: true },
    rules: [],
  } as Parameters<typeof formatPermissions>[0]);
  expect(text.split('\n').map((l) => l.slice(0, 8))).toEqual([
    'mode    ',
    'levels  ',
    'sandbox ',
    'rules   ',
  ]);
});

test('/permissions lines up its labels', () => {
  const text = formatPermissions({
    mode: 'default',
    modes: ['default'],
    levels: { read: 'allow', edit: 'ask', bash: 'ask', web: 'ask', websearch: 'allow', mcp: 'ask' },
    sandbox: { active: true },
    rules: [],
  } as Parameters<typeof formatPermissions>[0]);
  expect(text.split('\n').map((l) => l.slice(0, 8))).toEqual([
    'mode    ',
    'levels  ',
    'sandbox ',
    'rules   ',
  ]);
});

test('/permissions lines up its labels', () => {
  const text = formatPermissions({
    mode: 'default',
    modes: ['default'],
    levels: { read: 'allow', edit: 'ask', bash: 'ask', web: 'ask', websearch: 'allow', mcp: 'ask' },
    sandbox: { active: true },
    rules: [],
  } as Parameters<typeof formatPermissions>[0]);
  expect(text.split('\n').map((l) => l.slice(0, 8))).toEqual([
    'mode    ',
    'levels  ',
    'sandbox ',
    'rules   ',
  ]);
});

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

test('/effort takes a level or default, and says what follows from it', () => {
  expect(parseEffort('HIGH')).toBe('high');
  expect(parseEffort('default')).toBeNull();
  expect(parseEffort('extreme')).toBeUndefined();
  expect(effortNotice('max')).toContain('effort: max');
  expect(effortNotice(undefined)).toContain('following');
});

test("a session's effort comes from the latest change, else its summary", () => {
  expect(sessionEffort({}, { effort: 'low' })).toBe('low');
  expect(sessionEffort({ effort: 'high' }, { effort: 'low' })).toBe('high');
  expect(sessionEffort({ effort: null }, { effort: 'low' })).toBeUndefined();
});

test('/agents shows mode, route, model, and effort only when they differ from the defaults', () => {
  const text = formatAgents([
    { name: 'build', description: 'builds', source: 'builtin', mode: 'primary', route: 'auto' },
    {
      name: 'explore',
      description: 'searches',
      source: 'config',
      mode: 'subagent',
      route: 'local',
      effort: 'low',
    },
    {
      name: 'plan',
      description: 'plans',
      source: 'builtin',
      mode: 'all',
      route: 'auto',
      model: 'big',
    },
  ] as Parameters<typeof formatAgents>[0]);
  expect(text.split('\n')).toEqual([
    'build [builtin, primary]: builds',
    'explore [config, subagent, local, effort low]: searches',
    'plan [builtin, big]: plans',
  ]);
});

test('status marks take one cell in every terminal, so the space after them shows', () => {
  const marks = [
    ...(['acceptEdits', 'autoApprove', 'plan', 'bypassPermissions'] as const).map(modeIcon),
    tierIcon('local'),
    tierIcon('remote'),
  ];
  for (const mark of marks) {
    expect(stringWidth(mark)).toBe(1);
    // Emoji-capable symbols (☁ ⚠ ⏸) are drawn two cells wide by some terminals.
    expect(mark).not.toMatch(/\p{Emoji}/u);
  }
  expect(modeIcon('default')).toBe('');
});

test('cost estimates round to cents, with a floor for tiny ones', () => {
  expect(estimateLabel(undefined)).toBe('');
  expect(estimateLabel(0.004)).toBe('≈ <$0.01');
  expect(estimateLabel(0.0412)).toBe('≈ $0.04');
  expect(estimateLabel(1.5)).toBe('≈ $1.50');
});

describe('/autocompact', () => {
  test('takes on, off, or nothing, with --save anywhere', () => {
    expect(parseAutoCompact([])).toEqual({ save: false });
    expect(parseAutoCompact(['OFF'])).toEqual({ enabled: false, save: false });
    expect(parseAutoCompact(['--save', 'on'])).toEqual({ enabled: true, save: true });
    expect(parseAutoCompact(['maybe'])).toBeUndefined();
    expect(parseAutoCompact(['on', 'off'])).toBeUndefined();
  });

  test('says when compaction starts and where the choice was saved', () => {
    expect(autoCompactLabel({ enabled: true, threshold: 0.7, window: 100_000 })).toBe(
      'Auto-compact is on: older messages are summarized at ~70k tokens (70% of the window).',
    );
    expect(autoCompactLabel({ enabled: false, threshold: 0.7, savedTo: '/c.json' })).toBe(
      'Auto-compact is off: /compact summarizes on demand. Saved to /c.json.',
    );
  });
});
