import { beforeAll, expect, test } from 'bun:test';
import type { InitializeResult, SessionRoles, SessionSummary } from '@switchback/protocol';
import type { Window } from 'happy-dom';
import type { HostToWebview, WebviewToHost } from '../messages.ts';
import { installDom } from './test-dom.ts';

/** The chat webview, loaded into a DOM with a stand-in for VS Code's webview API. */
const posted: WebviewToHost[] = [];
let window: Window;
const send = async (m: HostToWebview) => {
  window.dispatchEvent(new window.MessageEvent('message', { data: m }));
  await Bun.sleep(0);
};
const $ = (selector: string) => window.document.querySelector(selector) as unknown as HTMLElement;

beforeAll(async () => {
  window = installDom({
    acquireVsCodeApi: () => ({ postMessage: (m: WebviewToHost) => posted.push(m) }),
  });
  window.document.body.innerHTML = '<div id="app"></div>';
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
const init = {
  agents: [{ name: 'build' }],
  models: [
    { alias: 'fast', ref: { provider: 'ollama', model: 'qwen3' }, tier: 'local' },
    { alias: 'opus', ref: { provider: 'anthropic', model: 'claude-opus-5' }, tier: 'remote' },
  ],
} as unknown as InitializeResult;
const roles: SessionRoles = {
  current: ['fast'],
  escalate: [['large'], ['opus']],
  review: { mode: 'auto', models: [] },
  overridden: [],
};

test('route, agent, and role controls render and post the right messages', async () => {
  await send({ type: 'ready', init, session, route: 'auto' });
  await send({ type: 'roles', roles, sessionId: 's1' });
  const controls = $('#controls');
  expect(controls.textContent).toContain('Agent build');
  const model = $('select[data-current]') as HTMLSelectElement;
  expect(model.value).toBe('fast');
  expect(model.textContent).toContain('opus (claude-opus-5) · remote · step 2');
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

test('the model dropdown makes a model current, or opens the full picker', async () => {
  const pick = (value: string) => {
    const model = $('select[data-current]') as HTMLSelectElement;
    model.value = value;
    model.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  };
  pick('opus');
  expect(posted.at(-1)).toEqual({ type: 'setCurrent', alias: 'opus' });
  // Until the engine says otherwise, the dropdown still shows the current model.
  expect(($('select[data-current]') as HTMLSelectElement).value).toBe('fast');
  pick(':choose');
  expect(posted.at(-1)).toEqual({ type: 'chooseRole', role: 'current' });
  expect($('select[data-current]').textContent).not.toContain('Make this my default');
  await send({
    type: 'roles',
    sessionId: 's1',
    roles: { ...roles, current: ['opus', 'fast'], overridden: ['current'] },
  });
  pick(':save');
  expect(posted.at(-1)).toEqual({ type: 'saveRoles' });
  await send({ type: 'roles', roles, sessionId: 's1' });
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
    event: { type: 'roles.updated', sessionId: 's1', roles: { ...roles, current: ['opus'] } },
  });
  expect(($('select[data-current]') as HTMLSelectElement).value).toBe('opus');
  // Another session's roles don't touch this one's controls.
  await send({
    type: 'event',
    event: { type: 'roles.updated', sessionId: 'other', roles: { ...roles, current: ['fast'] } },
  });
  expect(($('select[data-current]') as HTMLSelectElement).value).toBe('opus');
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
  // The reason is its own line, not run on after the question.
  expect($('#prompts .hint')?.textContent).toBe('3 consecutive tool errors');
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

test('a pasted image waits above the input and goes with the next prompt', async () => {
  // Idle, so the prompt shows in the transcript at once rather than queueing.
  await send({
    type: 'event',
    event: { type: 'turn.completed', sessionId: 's1', turnId: 't', stopReason: 'end_turn' },
  });
  const png = new window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', {
    type: 'image/png',
  });
  const data = new window.DataTransfer();
  data.items.add(png);
  const paste = new window.ClipboardEvent('paste', { clipboardData: data, cancelable: true });
  $('#input').dispatchEvent(paste as unknown as Event);
  for (let i = 0; i < 20 && !$('#images').innerHTML; i++) await Bun.sleep(5);
  expect($('#images img').getAttribute('alt')).toBe('image 1');
  type('');
  key('Enter');
  expect(posted.at(-1)).toMatchObject({
    type: 'prompt',
    text: 'Attached: image 1',
    images: [{ name: 'image 1', data: 'iVBORw==' }],
  });
  expect($('#images').innerHTML).toBe('');
  expect($('#log .image img').getAttribute('alt')).toBe('image 1');
});

test('Escalate now asks the host to escalate', async () => {
  await send({ type: 'roles', sessionId: 's1', roles: { ...roles, escalate: [['large']] } });
  $('[data-escalate-now]').click();
  expect(posted.at(-1)).toEqual({ type: 'command', name: 'up', args: [] });
});

test('a permission prompt can be answered', async () => {
  await send({ type: 'ready', init, session, route: 'auto' });
  await send({
    type: 'event',
    event: {
      type: 'permission.requested',
      sessionId: 's1',
      requestId: 'perm_1',
      tool: 'bash',
      summary: '$ ls',
      input: { command: 'ls' },
      rules: ['bash(ls:*)'],
    },
  });
  const allow = $('#prompts [data-perm="once"]');
  expect(allow).toBeTruthy();
  allow.click();
  expect(posted.at(-1)).toEqual({
    type: 'permission',
    requestId: 'perm_1',
    decision: 'allow_once',
  });
  expect($('#prompts').textContent).toBe('');
});

test('every kind of prompt answers: deny with a note, plans, and escalations', async () => {
  const ask = (requestId: string, extra: object = {}) =>
    send({
      type: 'event',
      event: {
        type: 'permission.requested',
        sessionId: 's1',
        requestId,
        tool: 'bash',
        summary: '$ rm x',
        input: { command: 'rm x' },
        ...extra,
      },
    });
  await ask('perm_2');
  $('#prompts [data-perm="tell"]').click();
  const form = $('#prompts form.feedback') as HTMLFormElement;
  expect(form.hidden).toBe(false);
  (form.querySelector('input') as HTMLInputElement).value = 'use trash instead';
  form.dispatchEvent(
    new window.Event('submit', { cancelable: true, bubbles: true }) as unknown as Event,
  );
  expect(posted.at(-1)).toEqual({
    type: 'permission',
    requestId: 'perm_2',
    decision: 'deny',
    feedback: 'use trash instead',
  });

  await ask('perm_3', { tool: 'exit_plan_mode', plan: '1. do it' });
  $('#prompts [data-perm="always"]').click();
  expect(posted.at(-1)).toMatchObject({ requestId: 'perm_3', decision: 'allow_always' });

  await send({
    type: 'event',
    event: {
      type: 'escalation.requested',
      sessionId: 's1',
      requestId: 'esc_1',
      reason: 'stuck',
      target: { provider: 'p', model: 'big' },
    },
  });
  $('#prompts [data-esc="1"]').click();
  expect(posted.at(-1)).toEqual({ type: 'escalation', requestId: 'esc_1', approve: true });
});

test('tabs: a new tab, a background turn, the dashboard, and closing', async () => {
  // One tab, nothing elsewhere: no strip.
  expect($('#tabs').innerHTML).toBe('');
  const second = { ...session, id: 's2', title: 'docs pass' };
  await send({ type: 'session', session: second, tab: 'new' });
  expect(window.document.querySelectorAll('#tabs .tab')).toHaveLength(2);
  expect($('#tabs .tab.on').textContent).toContain('docs pass');

  // The first tab works in the background; its prompt doesn't show here.
  await send({ type: 'event', event: { type: 'turn.started', sessionId: 's1', turnId: 'b1' } });
  await send({
    type: 'event',
    event: {
      type: 'permission.requested',
      sessionId: 's1',
      requestId: 'bg',
      tool: 'bash',
      summary: 'rm -rf build',
      input: {},
    },
  });
  expect($('#prompts').textContent).not.toContain('rm -rf build');
  expect($('#tabs [data-tab="s1"]').className).toContain('waiting');

  $('[data-dashboard]').click();
  expect(posted.at(-1)).toEqual({ type: 'listSessions' });
  expect($('#dash').hidden).toBe(false);
  expect($('#dash').textContent).toContain('waiting for you');

  // Switching tells the host where prompts go now, and shows that tab's prompt.
  ($('#dash .open[data-tab="s1"]') as HTMLElement).click();
  expect(posted.at(-1)).toEqual({ type: 'switchTab', sessionId: 's1' });
  expect($('#dash').hidden).toBe(true);
  expect($('#prompts').textContent).toContain('rm -rf build');

  ($('#tabs [data-close-tab="s2"]') as HTMLElement).click();
  expect($('#tabs').innerHTML).toBe('');
  type('/tab new');
  key('Enter');
  expect(posted.at(-1)).toEqual({ type: 'newTab' });
  type('/tabs');
  key('Enter');
  expect($('#dash').hidden).toBe(false);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  expect($('#dash').hidden).toBe(true);
});

test('a new session clears the chat; the last one stays in the history', async () => {
  await send({ type: 'info', text: 'from the last session' });
  expect($('#log').textContent).toContain('from the last session');
  await send({ type: 'session', session: { ...session, id: 's9' } });
  expect($('#log').textContent).not.toContain('from the last session');
  expect($('#log').textContent).toContain('new session · agent build');
  type('/resume');
  key('Enter');
  expect(posted.at(-1)).toEqual({ type: 'command', name: 'resume', args: [] });
});
