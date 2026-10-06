import { beforeAll, expect, test } from 'bun:test';
import type { InitializeResult, SessionRoles, SessionSummary } from '@switchback/protocol';
import { Window } from 'happy-dom';
import type { HostToWebview, WebviewToHost } from '../messages.ts';

/** The chat webview, loaded into a DOM with a stand-in for VS Code's webview API. */
const posted: WebviewToHost[] = [];
let window: Window;
const send = async (m: HostToWebview) => {
  window.dispatchEvent(new window.MessageEvent('message', { data: m }));
  await Bun.sleep(0);
};
const $ = (selector: string) => window.document.querySelector(selector) as unknown as HTMLElement;

beforeAll(async () => {
  window = new Window();
  window.document.body.innerHTML = '<div id="app"></div>';
  Object.assign(globalThis, {
    window,
    document: window.document,
    acquireVsCodeApi: () => ({ postMessage: (m: WebviewToHost) => posted.push(m) }),
  });
  await import('./main.ts');
});

const session: SessionSummary = {
  id: 's1',
  title: '',
  agent: 'build',
  createdAt: '',
  updatedAt: '',
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
};
const init = { agents: [{ name: 'build' }], models: [] } as unknown as InitializeResult;
const roles: SessionRoles = {
  start: ['fast'],
  escalate: [['large'], ['opus']],
  review: { mode: 'auto', models: [] },
  overridden: [],
};

test('route, agent, and role controls render and post the right messages', async () => {
  await send({ type: 'ready', init, session, route: 'auto' });
  await send({ type: 'roles', roles });
  const controls = $('#controls');
  expect(controls.textContent).toContain('Agent build');
  expect(controls.textContent).toContain('Start fast');
  expect(controls.textContent).toContain('Escalate large → opus');
  expect(controls.textContent).toContain('Review the escalation ladder');
  expect($('[data-route="auto"]').className).toBe('on');

  $('[data-route="local"]').click();
  expect(posted.at(-1)).toEqual({ type: 'setRoute', route: 'local' });
  expect($('[data-route="local"]').className).toBe('on');
  $('[data-role="escalate"]').click();
  expect(posted.at(-1)).toEqual({ type: 'chooseRole', role: 'escalate' });
  $('[data-agent]').click();
  expect(posted.at(-1)).toEqual({ type: 'chooseAgent' });
});

test('the step the session is on is highlighted; roles.updated refreshes the pills', async () => {
  await send({
    type: 'event',
    event: {
      type: 'route.decided',
      sessionId: 's1',
      turnId: 't',
      tier: 'local',
      model: { provider: 'gpu', model: 'large-model' },
      rule: 'escalation',
      reason: 'stuck',
      step: 1,
      steps: 2,
    },
  });
  expect($('.pill .here').textContent).toBe('large');
  await send({
    type: 'event',
    event: { type: 'roles.updated', sessionId: 's1', roles: { ...roles, start: ['opus'] } },
  });
  expect($('[data-role="start"]').textContent).toContain('opus');
});

test('an escalation asks to escalate or stay, not "remote or local"', async () => {
  await send({
    type: 'event',
    event: {
      type: 'escalation.requested',
      sessionId: 's1',
      requestId: 'r1',
      target: { provider: 'anthropic', model: 'claude-opus-5' },
      reason: '3 consecutive tool errors',
    },
  });
  expect($('#prompts').textContent).toContain('Escalate');
  expect($('#prompts').textContent).toContain('Stay on the current model');
});

const type = (text: string) => {
  const input = $('#input') as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new window.Event('input') as unknown as Event);
};
const key = (k: string) =>
  $('#input').dispatchEvent(new window.KeyboardEvent('keydown', { key: k }) as unknown as Event);

test('typing / opens the command menu and filters it by name', () => {
  type('/');
  expect($('#menu').hidden).toBe(false);
  expect($('#menu').textContent).toContain('/compact');
  // TUI-only commands aren't offered.
  expect($('#menu').textContent).not.toContain('/exit');
  type('/comp');
  const rows = window.document.querySelectorAll('#menu .menu-item');
  expect(rows[0]?.getAttribute('data-cmd')).toBe('compact');
  type('/compact now');
  expect($('#menu').hidden).toBe(true);
});

test('Enter runs the highlighted command; the host gets the ones it handles', () => {
  type('/us');
  key('Enter');
  expect(posted.at(-1)).toEqual({ type: 'command', name: 'usage', args: [] });
  expect($('#menu').hidden).toBe(true);
  expect(($('#input') as HTMLTextAreaElement).value).toBe('');
});

test('arrow keys move the highlight and Tab completes the name for arguments', () => {
  type('/re');
  key('ArrowDown');
  expect($('#menu .menu-item.active').getAttribute('data-cmd')).toBe('resume');
  key('Tab');
  expect(($('#input') as HTMLTextAreaElement).value).toBe('/resume ');
  expect($('#menu').hidden).toBe(true);
  key('Escape');
});

test('the / button toggles the menu; routing commands run in the webview', () => {
  type('');
  $('#slash').click();
  expect($('#menu').hidden).toBe(false);
  $('#slash').click();
  expect($('#menu').hidden).toBe(true);

  type('/remote');
  key('Enter');
  expect(posted.at(-1)).toEqual({ type: 'setRoute', route: 'remote' });
  expect($('[data-route="remote"]').className).toBe('on');
});

test('custom commands are listed and go to the engine as prompts', async () => {
  await send({
    type: 'commands',
    commands: [
      { name: 'fix-issue', args: '<n>', description: 'Fix an issue', source: 'project' },
      { name: 'standup', description: 'Summarize yesterday', source: 'user' },
    ],
  });
  type('/fix');
  expect($('#menu').textContent).toContain('Custom');
  expect($('#menu').textContent).toContain('Fix an issue (project)');
  // It needs an argument, so Enter completes the name and waits for it.
  key('Enter');
  expect(($('#input') as HTMLTextAreaElement).value).toBe('/fix-issue ');
  type('/fix-issue 12');
  key('Enter');
  expect(posted.at(-1)).toMatchObject({ type: 'prompt', text: '/fix-issue 12' });
  type('/stand');
  key('Enter');
  expect(posted.at(-1)).toMatchObject({ type: 'prompt', text: '/standup' });
});

test('typed commands pass their arguments; unknown ones say so', async () => {
  type('/usage model');
  key('Escape');
  key('Enter');
  expect(posted.at(-1)).toEqual({ type: 'command', name: 'usage', args: ['model'] });
  type('/frobnicate');
  key('Escape');
  key('Enter');
  expect($('#log').textContent).toContain('unknown command /frobnicate');
  await send({ type: 'info', text: 'MCP servers\n  none' });
  expect($('#log').textContent).toContain('MCP servers');
});
