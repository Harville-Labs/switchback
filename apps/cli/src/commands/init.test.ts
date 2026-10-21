import { expect, test } from 'bun:test';
import { answersGiven, type InitFlags } from './init.ts';

const plain: InitFlags = {
  yes: false,
  noLocal: false,
  cwd: '/w',
  localUrls: [],
  localModels: [],
  contextWindows: [],
  remotes: [],
  remoteModels: [],
};

test('plain switchback init answers nothing, so it opens Switchback on setup', () => {
  expect(answersGiven(plain)).toBe(false);
  expect(answersGiven({ ...plain, yes: true, scope: 'project' })).toBe(false);
});

test('any answering flag keeps setup as terminal prompts', () => {
  expect(answersGiven({ ...plain, remotes: ['openai'] })).toBe(true);
  expect(answersGiven({ ...plain, noLocal: true })).toBe(true);
  expect(answersGiven({ ...plain, telemetry: false })).toBe(true);
});
