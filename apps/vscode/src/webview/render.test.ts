import { beforeAll, expect, test } from 'bun:test';
import { initialView, reduce, type ViewState } from '@switchback/client/view';
import type { EngineEvent } from '@switchback/protocol';
import { Window } from 'happy-dom';

let renderItem: typeof import('./render.ts').renderItem;
let document: Window['document'];
beforeAll(async () => {
  const window = new Window();
  Object.assign(globalThis, { window, document: window.document });
  document = window.document;
  ({ renderItem } = await import('./render.ts'));
});

const ref = { provider: 'p', model: 'm' };
const events: EngineEvent[] = [
  {
    type: 'subagent.started',
    sessionId: 'root',
    childSessionId: 'c1',
    agent: 'general',
    task: 'survey <code>',
  },
  {
    type: 'tool.started',
    sessionId: 'c1',
    parentSessionId: 'root',
    turnId: 't',
    callId: 'k',
    name: 'grep',
    input: { pattern: 'x' },
  },
  {
    type: 'subagent.started',
    sessionId: 'c1',
    parentSessionId: 'root',
    childSessionId: 'g1',
    agent: 'explore',
    task: 'dig',
  },
  {
    type: 'route.decided',
    sessionId: 'g1',
    parentSessionId: 'c1',
    turnId: 'g',
    tier: 'local',
    model: ref,
    rule: 'agent-pin',
    reason: 'explore runs local',
  },
  {
    type: 'text.delta',
    sessionId: 'c1',
    parentSessionId: 'root',
    turnId: 't',
    text: 'found <b>it</b>',
  },
];

function html(view: ViewState, expanded: string[]) {
  const el = document.createElement('div');
  el.innerHTML = view.items.map((i) => renderItem(i, view, new Set(expanded))).join('');
  return el;
}

test('subagents render as nested collapsible sections, depth 2 included', () => {
  const view = events.reduce(reduce, initialView('root'));
  const el = html(view, ['c1']);
  const outer = el.querySelector('details[data-sub="c1"]');
  expect(outer?.hasAttribute('open')).toBe(true);
  expect(outer?.querySelector('.children .tool')?.textContent).toContain('grep');
  const inner = outer?.querySelector('details[data-sub="g1"]');
  expect(inner).toBeTruthy();
  expect(inner?.hasAttribute('open')).toBe(false);
  expect(inner?.querySelector('.route')?.textContent).toContain('explore runs local');
  // Model and task text are escaped, never markup.
  expect(outer?.querySelector('summary')?.innerHTML).toContain('&lt;code&gt;');
  expect(el.querySelector('b')).toBeNull();
});

test('reasoning is a closed Thinking row that opens to paragraphs, kept open by key', () => {
  const item = {
    kind: 'assistant' as const,
    id: 'a0',
    text: '',
    reasoning: '**Plan**\n\n\n\nRead <the> parser.',
  };
  const view: ViewState = { ...initialView('s'), running: true, items: [item] };
  const closed = renderItem(item, view, new Set());
  expect(closed).toContain('<summary>✻ Thinking…</summary>');
  expect(closed).not.toContain(' open>');
  const open = renderItem(item, view, new Set(['think:s:a0']));
  expect(open).toContain('data-think="think:s:a0" open');
  expect(open).toContain('Plan\n\nRead &#60;the&#62; parser.');
  const done = renderItem({ ...item, text: 'Done.' }, { ...view, running: false }, new Set());
  expect(done).toContain('<summary>✻ Thought</summary>');
});

test('an image shows as a thumbnail only from an image data URL', () => {
  const view = initialView('s');
  const ok = renderItem(
    { kind: 'image', id: 'i', name: 'a.png', src: 'data:image/png;base64,iVBORw==' },
    view,
    new Set(),
  );
  expect(ok).toContain('<img src="data:image/png;base64,iVBORw==" alt="a.png">');
  const bad = renderItem(
    { kind: 'image', id: 'i', name: 'x', src: 'javascript:alert(1)" onerror="x' },
    view,
    new Set(),
  );
  expect(bad).not.toContain('<img');
  expect(bad).toContain('🖼 x');
});
