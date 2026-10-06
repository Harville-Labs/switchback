/**
 * Chat webview. Renders from the same view-model reducer as the TUI
 * (`@switchback/client`), so both clients show identical session state.
 */
import {
  commandQuery,
  commandsFor,
  matchCommands,
  type SlashCommand,
} from '@switchback/client/commands';
import { pickCopy } from '@switchback/client/copy';
import { formatSubagents, formatUsage } from '@switchback/client/format';
import {
  addInfo,
  addUserPrompt,
  fromTranscript,
  initialView,
  reduce,
  resolveEscalation,
  resolvePermission,
  type ViewItem,
  type ViewState,
} from '@switchback/client/view';
import type { PermissionMode, RoutePreference, SessionRoles } from '@switchback/protocol';
import type { EditorContextState } from '../context.ts';
import type { HostToWebview, RoleName, WebviewToHost } from '../messages.ts';
import { renderControls as renderControlsHtml } from './controls.ts';
import { renderMenu } from './menu.ts';
import {
  esc,
  permissionAnswer,
  renderPrompt,
  renderQueue,
  renderItem as renderViewItem,
} from './render.ts';
import { STYLES } from './styles.ts';

declare function acquireVsCodeApi(): { postMessage(m: WebviewToHost): void };
const vscode = acquireVsCodeApi();

let view: ViewState = initialView('');
let route: RoutePreference = 'auto';
let connected = false;
let agent = '';
/** The session's mode until a `mode.changed` event says otherwise. */
let sessionMode: PermissionMode = 'default';
/** Kept outside `view`, which is rebuilt when the session changes. */
let roles: SessionRoles | undefined;

const ICONS = {
  // The product mark: a path that doubles back on itself.
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20h9a3 3 0 0 0 0-6H10a3 3 0 0 1 0-6h9"/><circle cx="5" cy="20" r="1.5" fill="currentColor"/><circle cx="19" cy="8" r="1.5" fill="currentColor"/></svg>',
  slash:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="1.5" y="1.5" width="13" height="13" rx="3"/><path d="M9.5 4.5l-3 7"/></svg>',
  send: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
};

const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
<style>${STYLES}</style>
<div id="log"></div>
<div id="prompts"></div>
<div id="queue"></div>
<footer>
  <div class="composer">
    <div id="menu" class="menu" role="listbox" aria-label="Commands" hidden></div>
    <div id="chips" class="chips"></div>
    <textarea id="input" rows="1" aria-label="Message" placeholder="Ask anything, / for commands"></textarea>
    <div class="toolbar">
      <div class="side">
        <button id="slash" class="icon" title="Commands (/)" aria-label="Commands" aria-haspopup="listbox">${ICONS.slash}</button>
      </div>
      <div class="side">
        <span id="status"></span>
        <button id="now" class="btn secondary now" title="Stop the running turn and send this now" hidden>Send now</button>
        <button id="send" class="send" title="Send (Enter)" aria-label="Send">${ICONS.send}</button>
      </div>
    </div>
  </div>
  <div id="controls" class="controls"></div>
</footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $<HTMLDivElement>('log');
const prompts = $<HTMLDivElement>('prompts');
const input = $<HTMLTextAreaElement>('input');
const controls = $<HTMLDivElement>('controls');
const statusEl = $<HTMLSpanElement>('status');
const sendBtn = $<HTMLButtonElement>('send');
const nowBtn = $<HTMLButtonElement>('now');
const queueEl = $<HTMLDivElement>('queue');
const menu = $<HTMLDivElement>('menu');
const slashBtn = $<HTMLButtonElement>('slash');

/** Subagent sections the user opened; kept across re-renders. */
const expanded = new Set<string>();
const renderItem = (item: ViewItem, ctx: ViewState = view) => renderViewItem(item, ctx, expanded);

const WELCOME = `<div class="welcome">${ICONS.mark}<h1>Switchback</h1><p>Runs on your local model and escalates to a hosted one only when a turn needs it.</p><div class="keys"><span><kbd>/</kbd> commands</span><span><kbd>Enter</kbd> send</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span></div></div>`;

function render() {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  // Until the first prompt the session only has notices, so lead with the welcome.
  const fresh = !view.items.some((i) => i.kind !== 'info');
  log.innerHTML = (fresh ? WELCOME : '') + view.items.map((i) => renderItem(i)).join('');
  if (nearBottom) log.scrollTop = log.scrollHeight;

  prompts.innerHTML = renderPrompt(view);

  // One button: send while idle, stop while a turn runs.
  queueEl.innerHTML = renderQueue(view.queue ?? []);
  syncSend();
  renderControls();
  statusEl.textContent = connected
    ? `${view.private ? '🔒 local only · ' : ''}$${view.costUsd.toFixed(4)}${view.savingsUsd > 0.005 ? ` · saved ~$${view.savingsUsd.toFixed(2)}` : ''}`
    : 'disconnected';
}

/** Routing, mode, agent, and the models in each role, each one click from its picker. */
function renderControls() {
  controls.innerHTML = renderControlsHtml({
    route,
    mode: view.mode ?? sessionMode,
    agent,
    roles,
    ladderStep: view.ladder?.step ?? 0,
  });
}

function setRoute(r: RoutePreference) {
  route = r;
  vscode.postMessage({ type: 'setRoute', route: r });
}

controls.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const r = btn.dataset.route as RoutePreference | undefined;
  if (r) {
    setRoute(r);
    render();
  } else if (btn.hasAttribute('data-agent')) vscode.postMessage({ type: 'chooseAgent' });
  else if (btn.hasAttribute('data-mode')) vscode.postMessage({ type: 'chooseMode' });
  else if (btn.dataset.role)
    vscode.postMessage({ type: 'chooseRole', role: btn.dataset.role as RoleName });
});

// `toggle` doesn't bubble, so listen in the capture phase.
log.addEventListener(
  'toggle',
  (e) => {
    const d = e.target as HTMLDetailsElement;
    const id = d.dataset?.sub;
    if (!id) return;
    if (d.open) expanded.add(id);
    else expanded.delete(id);
  },
  true,
);

log.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const anchor = target.closest('a');
  if (anchor) {
    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) vscode.postMessage({ type: 'openLink', href });
    return;
  }
  const button = target.closest('button');
  const code = button?.closest('.code')?.querySelector('code')?.textContent;
  if (!button || code == null) return;
  if (button.hasAttribute('data-copy')) vscode.postMessage({ type: 'copy', text: code });
  if (button.hasAttribute('data-insert')) vscode.postMessage({ type: 'insert', text: code });
});

prompts.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const perm = view.permissions[0];
  const escl = view.escalations[0];
  const answer = btn.dataset.perm ? permissionAnswer(btn.dataset.perm) : undefined;
  if (answer && perm) {
    vscode.postMessage({ type: 'permission', requestId: perm.requestId, ...answer });
    view = resolvePermission(view, perm.requestId, answer.decision);
  } else if (btn.dataset.esc && escl) {
    vscode.postMessage({
      type: 'escalation',
      requestId: escl.requestId,
      approve: btn.dataset.esc === '1',
    });
    view = resolveEscalation(view, escl.requestId);
  }
  render();
});

// Editor context offered as attachments. Selection is on by default (and
// visible as a chip); file and problems are opt-in.
let ctx: EditorContextState = { problems: 0 };
const attach = { file: false, selection: true, problems: false };
const chips = $<HTMLDivElement>('chips');

function renderChips() {
  const items: { key: keyof typeof attach; label: string }[] = [];
  if (ctx.selection)
    items.push({
      key: 'selection',
      label: `${ctx.selection.path}:${ctx.selection.startLine}-${ctx.selection.endLine}`,
    });
  else if (ctx.file) items.push({ key: 'file', label: ctx.file });
  if (ctx.problems)
    items.push({
      key: 'problems',
      label: `${ctx.problems} problem${ctx.problems === 1 ? '' : 's'}`,
    });
  chips.innerHTML = items
    .map(
      (c) =>
        `<button class="chip${attach[c.key] ? ' on' : ''}" data-chip="${c.key}" title="Include with the next prompt">${attach[c.key] ? '✓' : '+'} ${esc(c.label)}</button>`,
    )
    .join('');
}

chips.addEventListener('click', (e) => {
  const key = (e.target as HTMLElement).closest('button')?.dataset.chip as
    | keyof typeof attach
    | undefined;
  if (!key) return;
  attach[key] = !attach[key];
  renderChips();
});

// Slash command menu: opened by the / button or by typing / at the start of
// the input, filtered as the command name is typed.
let menuItems: SlashCommand[] = [];
let menuActive = 0;

function openMenu(query: string) {
  menuItems = matchCommands(query, 'vscode');
  menuActive = Math.min(menuActive, Math.max(0, menuItems.length - 1));
  menu.innerHTML = renderMenu(menuItems, menuActive);
  menu.hidden = false;
  slashBtn.classList.add('on');
  menu.querySelector('.menu-item.active')?.scrollIntoView?.({ block: 'nearest' });
}

function closeMenu() {
  menu.hidden = true;
  menuActive = 0;
  slashBtn.classList.remove('on');
}

/** Keep the menu in step with the input: open while it's a bare `/name`. */
function syncMenu() {
  const query = commandQuery(input.value);
  if (query !== undefined) openMenu(query);
  else if (!menu.hidden) closeMenu();
}

function pickCommand(c: SlashCommand) {
  closeMenu();
  input.value = '';
  autosize();
  runCommand(c.name, []);
  input.focus();
}

// Keep focus in the input, so its blur doesn't close the menu this click toggles.
slashBtn.addEventListener('mousedown', (e) => e.preventDefault());
slashBtn.addEventListener('click', () => {
  if (!menu.hidden) {
    closeMenu();
    input.focus();
    return;
  }
  // Like typing it: start a command unless the input already has one.
  if (!input.value.startsWith('/')) input.value = '/';
  autosize();
  input.focus();
  syncMenu();
});

// mousedown, not click, so the textarea keeps focus.
menu.addEventListener('mousedown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
  if (!row) return;
  e.preventDefault();
  const c = menuItems[Number(row.dataset.i)];
  if (c) pickCommand(c);
});

menu.addEventListener('mousemove', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
  const i = Number(row?.dataset.i);
  if (!row || i === menuActive) return;
  menuActive = i;
  for (const el of menu.querySelectorAll('.menu-item')) el.classList.toggle('active', el === row);
});

function addNotice(text: string) {
  view = addInfo(view, text);
  render();
}

/** Run a slash command: routing and view-only ones here, the rest in the host. */
function runCommand(name: string, args: string[]) {
  if (!commandsFor('vscode').some((c) => c.name === name)) {
    addNotice(`unknown command /${name}; type / to see commands`);
    return;
  }
  switch (name) {
    case 'auto':
    case 'local':
    case 'remote':
      setRoute(name);
      addNotice(`routing: ${name}`);
      return;
    case 'help':
      input.value = '/';
      syncMenu();
      return;
    case 'subagents':
      addNotice(formatSubagents(view, 'Expand a subagent in the chat to see what it did.'));
      return;
    case 'copy': {
      const pick = pickCopy(view.items, args[0]);
      if ('error' in pick) addNotice(`copy: ${pick.error}`);
      else {
        vscode.postMessage({ type: 'copy', text: pick.text });
        addNotice(`Copied ${pick.what}.`);
      }
      return;
    }
    default:
      vscode.postMessage({ type: 'command', name, args });
  }
}

/**
 * One button: send while idle; during a turn, stop when nothing is typed and
 * queue when something is (with **Send now** beside it to interrupt).
 */
function syncSend() {
  const typed = !!input.value.trim();
  const stop = view.running && !typed;
  sendBtn.innerHTML = stop ? ICONS.stop : ICONS.send;
  sendBtn.title = stop
    ? 'Stop (cancel the running turn)'
    : view.running
      ? 'Queue (Enter): the model reads it at its next step'
      : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', stop ? 'Stop' : view.running ? 'Queue' : 'Send');
  sendBtn.disabled = !connected || (!view.running && !typed);
  sendBtn.classList.toggle('stop', stop);
  nowBtn.hidden = !(view.running && typed);
}

function send(delivery?: 'interrupt') {
  const text = input.value.trim();
  if (view.running && !text) {
    vscode.postMessage({ type: 'cancel' });
    return;
  }
  if (!text || !connected) return;
  input.value = '';
  autosize();
  closeMenu();
  if (text.startsWith('/')) {
    const [name = '', ...args] = text.slice(1).split(/\s+/);
    runCommand(name, args);
    return;
  }
  const choice = {
    selection: attach.selection && !!ctx.selection,
    file: attach.file && !ctx.selection && !!ctx.file,
    problems: attach.problems && ctx.problems > 0,
  };
  // A queued prompt shows in the transcript once the model reads it (queue.delivered).
  const queued = view.running && delivery !== 'interrupt';
  if (!queued) view = addUserPrompt(view, text);
  const sent = [
    choice.selection && ctx.selection
      ? `${ctx.selection.path}:${ctx.selection.startLine}-${ctx.selection.endLine}`
      : '',
    choice.file ? ctx.file : '',
    choice.problems ? `problems in ${ctx.file}` : '',
  ].filter(Boolean);
  if (sent.length) view = addInfo(view, sent.map((x) => `📎 ${x}`).join('\n'));
  vscode.postMessage({
    type: 'prompt',
    text,
    attach: choice,
    ...(view.running ? { delivery: delivery ?? 'queue' } : {}),
  });
  render();
}

/** Grow the input with its content, up to the CSS max-height. */
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

sendBtn.addEventListener('click', () => send());
nowBtn.addEventListener('click', () => send('interrupt'));
queueEl.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest('button')?.dataset.dequeue;
  if (id) vscode.postMessage({ type: 'dequeue', id });
});
input.addEventListener('input', () => {
  autosize();
  syncMenu();
  syncSend();
});
input.addEventListener('blur', () => closeMenu());
input.addEventListener('keydown', (e) => {
  if (!menu.hidden) {
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move && menuItems.length) {
      e.preventDefault();
      menuActive = (menuActive + move + menuItems.length) % menuItems.length;
      openMenu(commandQuery(input.value) ?? '');
      return;
    }
    const c = menuItems[menuActive];
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      if (!c) return;
      // Tab completes the name so arguments can follow; Enter runs it.
      if (e.key === 'Tab') {
        input.value = `/${c.name} `;
        closeMenu();
      } else pickCommand(c);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  } else if (e.key === 'Escape' && view.running && !input.value) {
    // As in the TUI: Esc cancels the running turn; with text in the box it does nothing.
    e.preventDefault();
    vscode.postMessage({ type: 'cancel' });
  }
});

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      connected = true;
      route = m.route;
      agent = m.session.agent;
      sessionMode = m.session.permissionMode ?? 'default';
      if (view.sessionId !== m.session.id) view = initialView(m.session.id);
      break;
    case 'session':
      agent = m.session.agent;
      sessionMode = m.session.permissionMode ?? 'default';
      view = addInfo(
        { ...initialView(m.session.id), items: view.items },
        `new session · agent ${m.session.agent}`,
      );
      break;
    case 'event':
      view = reduce(view, m.event);
      if (m.event.type === 'roles.updated') roles = m.event.roles;
      break;
    case 'roles':
      roles = m.roles;
      break;
    case 'route':
      route = m.route;
      break;
    case 'usage':
      view = addInfo(view, formatUsage(m.usage, 'rule'));
      break;
    case 'info':
      view = addInfo(view, m.text);
      break;
    case 'history':
      agent = m.session.agent;
      sessionMode = m.session.permissionMode ?? 'default';
      view = addInfo(
        fromTranscript(m.session, m.messages),
        `resumed "${m.session.title || m.session.id}"`,
      );
      break;
    case 'prefill':
      input.value = m.text + input.value;
      autosize();
      input.focus();
      break;
    case 'context':
      ctx = m.state;
      renderChips();
      break;
    case 'attachSelection':
      attach.selection = true;
      renderChips();
      input.focus();
      break;
    case 'disconnected':
      connected = false;
      view = addInfo({ ...view, running: false }, m.message);
      break;
  }
  render();
});

vscode.postMessage({ type: 'loaded' });
render();
