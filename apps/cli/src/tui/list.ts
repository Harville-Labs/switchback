/** Scrolling math for the TUI's pickers, which show a window of a longer list. */

/** The first index to show so `selected` stays in a window of `rows` rows. */
export function windowStart(selected: number, count: number, rows: number): number {
  return Math.min(Math.max(0, selected - rows + 1), Math.max(0, count - rows));
}

/** The index `delta` rows from `i`, wrapping past either end. */
export function wrapStep(i: number, delta: number, count: number): number {
  return count ? (((i + delta) % count) + count) % count : 0;
}
