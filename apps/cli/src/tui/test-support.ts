/** Shared by the TUI's component tests. */
import type { SessionSummary } from '@switchback/protocol';

export const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * Waits for `check` to hold. CI runners, Windows most of all, can take a second
 * or more to lay out a frame, so a single tick is too short to assert after.
 */
export async function until(check: () => boolean, ms = 5_000) {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await tick();
}

const has = (frame: string, text: string | RegExp) =>
  typeof text === 'string' ? frame.includes(text) : text.test(frame);

/**
 * The transcript lays out a frame or two after it changes; wait for it. Ink writes
 * the frame as React commits, but `useInput` subscribes in an effect that runs
 * after, so wait one more tick before a test presses a key on what it shows.
 */
export async function frameWith(ui: { lastFrame(): string | undefined }, text: string | RegExp) {
  await until(() => has(ui.lastFrame() ?? '', text));
  const frame = ui.lastFrame() ?? '';
  await tick();
  return frame;
}

/** Waits for `text` to leave the frame, for a picker closing or a tab going away. */
export async function frameWithout(ui: { lastFrame(): string | undefined }, text: string | RegExp) {
  await until(() => !has(ui.lastFrame() ?? '', text));
  return ui.lastFrame() ?? '';
}

export const session = (id: string, title: string, agent = 'build'): SessionSummary => ({
  id,
  title,
  agent,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
});
