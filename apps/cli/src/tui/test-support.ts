/** Shared by the TUI's component tests. */
import type { SessionSummary } from '@switchback/protocol';

export const tick = () => new Promise((r) => setTimeout(r, 20));

/** The transcript lays out a frame or two after it changes; wait for it. */
export async function frameWith(ui: { lastFrame(): string | undefined }, text: string | RegExp) {
  for (let i = 0; i < 50; i++) {
    const frame = ui.lastFrame() ?? '';
    if (typeof text === 'string' ? frame.includes(text) : text.test(frame)) return frame;
    await tick();
  }
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
