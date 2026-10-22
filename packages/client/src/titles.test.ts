import { expect, test } from 'bun:test';
import type { SessionSummary } from '@switchback/protocol';
import { activeView, initialTabs, openTab, reduceTabs } from './tabs.ts';
import { terminalTitle } from './titles.ts';

const summary = (id: string, title = ''): SessionSummary => ({
  id,
  title,
  agent: 'build',
  createdAt: '',
  updatedAt: '',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
});

test("a rename updates the session's tab and dashboard row, and notes it in that tab", () => {
  let s = openTab(initialTabs(summary('a', 'old')), summary('b'));
  s = reduceTabs(s, {
    type: 'session.renamed',
    sessionId: 'a',
    title: 'Parser work',
    source: 'user',
  });
  expect(s.tabs.map((t) => t.session.title)).toEqual(['Parser work', '']);
  expect(s.sessions.a?.title).toBe('Parser work');
  const tabA = s.tabs.find((t) => t.session.id === 'a');
  expect(tabA?.view.items.at(-1)).toMatchObject({ kind: 'info', text: 'Renamed to "Parser work"' });
  expect(activeView(s).items).toEqual([]);
});

test('the title from the first prompt changes the tab without a note', () => {
  let s = initialTabs(summary('a'));
  s = reduceTabs(s, { type: 'session.renamed', sessionId: 'a', title: 'fix it', source: 'prompt' });
  expect(s.tabs[0]?.session.title).toBe('fix it');
  expect(activeView(s).items).toEqual([]);
});

test('compaction retitles say where the title came from', () => {
  let s = initialTabs(summary('a'));
  s = reduceTabs(s, {
    type: 'session.renamed',
    sessionId: 'a',
    title: 'Fix',
    source: 'compaction',
  });
  expect(activeView(s).items.at(-1)).toMatchObject({ text: 'Retitled "Fix" from the summary' });
});

test("a subagent's title doesn't rename the session it works for", () => {
  let s = initialTabs(summary('a', 'mine'));
  s = reduceTabs(s, {
    type: 'session.renamed',
    sessionId: 'child',
    parentSessionId: 'a',
    title: 'explore the parser',
    source: 'prompt',
  });
  expect(s.tabs[0]?.session.title).toBe('mine');
  expect(s.sessions.a?.title).toBe('mine');
});

test('terminal titles name the session and drop control characters', () => {
  expect(terminalTitle('Parser work')).toBe('Parser work · Switchback');
  expect(terminalTitle('evil\x07\x1b]0;pwned')).toBe('evil]0;pwned · Switchback');
  expect(terminalTitle('')).toBe('Switchback');
  expect(terminalTitle(undefined)).toBe('Switchback');
});
