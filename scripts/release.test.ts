import { expect, test } from 'bun:test';
import { changelogSection, cutChangelog, extensionChannel, readVersions } from './release.ts';

test('CLI, engine, and extension versions agree', () => {
  const versions = new Set(Object.values(readVersions()));
  expect([...versions]).toHaveLength(1);
  expect([...versions][0]).not.toBe('(missing)');
});

test('cutting and reading changelog sections', () => {
  const log =
    '# Changelog\n\n## [Unreleased]\n\n### Added\n- thing\n\n## [0.1.0] - 2026-09-26\n\n- first\n';
  const cut = cutChangelog(log, '0.2.0', '2026-10-01');
  expect(changelogSection(cut, '0.2.0')).toBe('### Added\n- thing');
  expect(changelogSection(cut, '0.1.0')).toBe('- first');
  expect(changelogSection(cut, 'Unreleased')).toBe('');
});

test('extension channel by version', () => {
  expect(extensionChannel('0.6.0')).toBe('pre-release');
  expect(extensionChannel('1.0.0')).toBe('release');
  expect(extensionChannel('1.0.0-rc.1')).toBe('none');
});
