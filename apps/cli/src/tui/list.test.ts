import { expect, test } from 'bun:test';
import { windowStart, wrapStep } from './list.ts';

test('the window starts at the top until the selection passes its last row', () => {
  expect(windowStart(0, 20, 9)).toBe(0);
  expect(windowStart(8, 20, 9)).toBe(0);
  expect(windowStart(9, 20, 9)).toBe(1);
});

test('the window never scrolls past the end of the list', () => {
  expect(windowStart(19, 20, 9)).toBe(11);
  expect(windowStart(3, 5, 9)).toBe(0);
});

test('stepping wraps from the last row to the first and back', () => {
  expect(wrapStep(19, 1, 20)).toBe(0);
  expect(wrapStep(0, -1, 20)).toBe(19);
  expect(wrapStep(4, 1, 20)).toBe(5);
  expect(wrapStep(0, 1, 0)).toBe(0);
});
