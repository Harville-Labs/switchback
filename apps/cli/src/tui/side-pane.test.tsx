import { describe, expect, test } from 'bun:test';
import { initialView } from '@switchback/client';
import { render } from 'ink-testing-library';
import { compactCount, SidePane, usageBar } from './SidePane.tsx';

describe('the side pane', () => {
  test('counts and bars stay short enough for a narrow pane', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(45_200)).toBe('45.2k');
    expect(compactCount(200_000)).toBe('200k');
    expect(compactCount(1_000_000)).toBe('1.0M');
    expect(usageBar(0.5, 10)).toBe('█████░░░░░');
    expect(usageBar(2, 4)).toBe('████');
  });

  test('shows context use, each MCP server with its state, and subagents', () => {
    const view = {
      ...initialView('s'),
      context: { tokens: 50_000, window: 200_000 },
      items: [
        {
          kind: 'subagent',
          id: 'a1',
          agent: 'explore',
          task: 'find the parser',
          status: 'running',
          activity: 'reading parse.ts',
          toolCalls: 2,
        },
      ],
    } as unknown as ReturnType<typeof initialView>;
    const ui = render(
      <SidePane
        view={view}
        servers={[
          { name: 'fs', state: 'connected', tools: 3 },
          { name: 'db', state: 'failed', tools: 0, error: 'spawn ENOENT' },
        ]}
      />,
    );
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('25% used');
    expect(frame).toContain('50.0k / 200k tokens');
    expect(frame).toContain('fs 3 tools');
    expect(frame).toContain('db failed');
    expect(frame).toContain('explore');
    expect(frame).toContain('reading parse.ts');
  });

  test('an agent that sets a color is drawn in it', () => {
    const view = {
      ...initialView('s'),
      items: [
        { kind: 'subagent', id: 'a1', agent: 'researcher', task: 't', status: 'ok', toolCalls: 1 },
      ],
    } as unknown as ReturnType<typeof initialView>;
    const ui = render(
      <SidePane view={view} servers={[]} agentColors={{ researcher: '#4C8BF5' }} />,
    );
    expect(ui.lastFrame()).toContain('researcher');
  });

  test('says so when there is nothing to show', () => {
    const frame = render(<SidePane view={initialView('s')} servers={[]} />).lastFrame() ?? '';
    expect(frame).toContain('nothing sent yet');
    expect(frame).toContain('none configured');
    expect(frame).toContain('none in this session');
  });
});
