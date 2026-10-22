import { expect, test } from 'bun:test';
import { session } from '../tui/test-support.ts';
import { exitHint, resumeOptions, resumeTarget } from './resume.ts';

const saved = [session('s-new', 'newest'), session('s-old', 'older')];

test('resume with no id opens the session picker', () => {
  expect(resumeOptions(undefined)).toEqual({ opening: 'sessions' });
});

test('resume with an id opens that session', () => {
  expect(resumeOptions('s-old')).toEqual({ resume: 's-old' });
  expect(resumeTarget('s-old', saved)).toEqual({ sessionId: 's-old' });
});

test('an id that is not a session in this workspace is an error that says how to find one', () => {
  const { sessionId, error } = resumeTarget('s-gone', saved);
  expect(sessionId).toBeUndefined();
  expect(error).toContain('no session in this workspace has the id "s-gone"');
  expect(error).toContain('`switchback resume`');
});

test('--continue opens the newest session, or a new one when there is none', () => {
  expect(resumeTarget('latest', saved)).toEqual({ sessionId: 's-new' });
  expect(resumeTarget('latest', [])).toEqual({});
});

test('leaving a session with messages prints the command that resumes it', () => {
  expect(exitHint('s-new', 3)).toBe('Resume this session with: switchback resume s-new');
});

test('leaving an empty session prints nothing', () => {
  expect(exitHint('s-new', 0)).toBeUndefined();
});
