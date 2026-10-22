/**
 * Chat webview. Renders from the same view-model reducer as the TUI
 * (`@switchback/client`), so both clients show identical session state.
 */
import { commandsFor } from '@switchback/client/commands';
import { pickCopy } from '@switchback/client/copy';
import { formatSubagents, speedLabel } from '@switchback/client/format';
import {
  activeTab,
  closeTab,
  dashboardRows,
  initialTabs,
  openTab,
  reduceTabs,
  replaceActive,
  switchTab,
  type TabsState,
  trackSessions,
  updateActiveView,
} from '@switchback/client/tabs';
import { cacheLabel, formatUsage } from '@switchback/client/usage';
import {
  addInfo,
  addUserPrompt,
  fromTranscript,
  initialView,
  resolveEscalation,
  resolvePermission,
  type ViewState,
} from '@switchback/client/view';
import type {
  InitializeResult,
  PermissionMode,
  RoutePreference,
  SessionRoles,
} from '@switchback/protocol';
import type { EditorContextState } from '../context.ts';
import type { HostToWebview, RoleName, WebviewToHost } from '../messages.ts';
import { CHOOSE_MODELS, renderControls as renderControlsHtml, SAVE_DEFAULT } from './controls.ts';
import { PendingImages } from './images.ts';
import {
  esc,
  permissionAnswer,
  renderPrompt,
  renderQueue,
  renderRows,
  renderTodos,
} from './render.ts';
import { SlashMenu } from './slash-menu.ts';
import { STYLES } from './styles.ts';
import { renderDashboard, renderTabStrip } from './tabs-view.ts';

declare function acquireVsCodeApi(): { postMessage(m: WebviewToHost): void };
const vscode = acquireVsCodeApi();

/**
 * The view of the tab in front. Edits to it go back into `tabs` on every
 * render (`syncTabs`); events and tab switches go through `tabs`.
 */
let view: ViewState = initialView('');
/** Every open session; undefined until the engine is ready. */
let tabs: TabsState | undefined;
let route: RoutePreference = 'auto';
let connected = false;
let models: InitializeResult['models'] = [];
/** The sessions dashboard is showing in place of the conversation. */
let dashboard = false;
/** Each session's roles, kept outside its view, which is rebuilt when it's resumed. */
const rolesBy = new Map<string, SessionRoles>();

/** The tabs with the latest edits to the view in front. */
function syncTabs(): TabsState | undefined {
  if (tabs) tabs = updateActiveView(tabs, () => view);
  return tabs;
}

/** Change the tabs; the view follows the tab in front. */
function setTabs(next: TabsState) {
  const before = tabs?.active;
  tabs = next;
  view = activeTab(next).view;
  if (next.active !== before) vscode.postMessage({ type: 'switchTab', sessionId: next.active });
}

const agentOf = () => (tabs ? activeTab(tabs).session.agent : '');
/** The session's mode until a `mode.changed` event says otherwise. */
const sessionModeOf = (): PermissionMode =>
  (tabs ? activeTab(tabs).session.permissionMode : undefined) ?? 'default';

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
<nav id="tabs" class="tabs"></nav>
<div id="dash" class="dash" hidden></div>
<div id="log"></div>
<div id="prompts"></div>
<div id="todos"></div>
<div id="queue"></div>
<footer>
  <div class="composer">
    <div id="menu" class="menu" role="listbox" aria-label="Commands" hidden></div>
    <div id="images" class="images"></div>
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
const todosEl = $<HTMLDivElement>('todos');
const menu = $<HTMLDivElement>('menu');
const slashBtn = $<HTMLButtonElement>('slash');
const tabsEl = $<HTMLElement>('tabs');
const dashEl = $<HTMLDivElement>('dash');

/** Subagent and reasoning sections the user opened; kept across re-renders. */
const expanded = new Set<string>();

const WELCOME = `<div class="welcome">${ICONS.mark}<h1>Switchback</h1><p>Runs on your local model and escalates to a hosted one only when a turn needs it.</p><div class="keys"><span><kbd>/</kbd> commands</span><span><kbd>Enter</kbd> send</span><span><kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span></div></div>`;

function render() {
  syncTabs();
  renderTabs();
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  // Until the first prompt the session only has notices, so lead with the welcome.
  const fresh = !view.items.some((i) => i.kind !== 'info');
  log.innerHTML = (fresh ? WELCOME : '') + renderRows(view.items, view, expanded);
  if (nearBottom) log.scrollTop = log.scrollHeight;

  prompts.innerHTML = renderPrompt(view);

  // One button: send while idle, stop while a turn runs.
  todosEl.innerHTML = renderTodos(view.todos);
  queueEl.innerHTML = renderQueue(view.queue ?? []);
  syncSend();
  renderControls();
  const cacheText = cacheLabel(view.cache);
  statusEl.textContent = connected
    ? `${view.private ? '🔒 local only · ' : ''}${view.speed ? `${speedLabel(view.speed.tokensPerSecond)} · ` : ''}$${view.costUsd.toFixed(4)}${view.savingsUsd > 0.005 ? ` · saved ~$${view.savingsUsd.toFixed(2)}` : ''}${cacheText ? ` · ${cacheText}` : ''}`
    : 'disconnected';
}

/** Routing, mode, agent, and the models in each role, each one click from its picker. */
function renderControls() {
  const html = renderControlsHtml({
    route,
    mode: view.mode ?? sessionModeOf(),
    agent: agentOf(),
    roles: view.roles ?? rolesBy.get(view.sessionId),
    models,
    ladderStep: view.ladder?.step ?? 0,
  });
  // Unchanged controls stay put: rebuilding them would close an open model dropdown.
  if (controls.innerHTML !== html) controls.innerHTML = html;
}

/** The tab strip, and the dashboard in place of the conversation while it's open. */
function renderTabs() {
  const rows = tabs ? dashboardRows(tabs) : [];
  // One tab and nothing elsewhere needs no strip; Show Sessions in the title bar opens the dashboard.
  const strip = rows.length > 1 || dashboard ? renderTabStrip(rows, dashboard) : '';
  if (tabsEl.innerHTML !== strip) tabsEl.innerHTML = strip;
  dashEl.hidden = !dashboard;
  log.hidden = dashboard;
  if (dashboard) {
    const html = renderDashboard(rows);
    if (dashEl.innerHTML !== html) dashEl.innerHTML = html;
  }
}

function showTab(sessionId: string) {
  dashboard = false;
  const t = syncTabs();
  if (!t) return;
  if (t.tabs.some((x) => x.session.id === sessionId)) setTabs(switchTab(t, sessionId));
  // Open in another window: the host fetches it, and it arrives as a new tab.
  else vscode.postMessage({ type: 'switchTab', sessionId });
  render();
}

function onTabClick(e: Event) {
  const target = e.target as HTMLElement;
  const close = target.closest<HTMLElement>('[data-close-tab]')?.dataset.closeTab;
  const t = syncTabs();
  if (close && t) {
    e.stopPropagation();
    setTabs(closeTab(t, close));
    render();
    return;
  }
  const tab = target.closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (tab) return showTab(tab);
  if (target.closest('[data-new-tab]')) {
    dashboard = false;
    vscode.postMessage({ type: 'newTab' });
    return render();
  }
  if (target.closest('[data-dashboard]')) {
    dashboard = !dashboard;
    if (dashboard) vscode.postMessage({ type: 'listSessions' });
    render();
  }
}
tabsEl.addEventListener('click', onTabClick);
dashEl.addEventListener('click', onTabClick);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !dashboard) return;
  dashboard = false;
  render();
});

/** `/tabs` and `/tab [n|new|close]`, as in the TUI. */
function runTabCommand(name: string, args: string[]) {
  const t = syncTabs();
  if (!t) return;
  const [what = ''] = args;
  if (name === 'tabs' || !what) {
    dashboard = true;
    vscode.postMessage({ type: 'listSessions' });
  } else if (what === 'new') vscode.postMessage({ type: 'newTab' });
  else if (what === 'close') {
    if (t.tabs.length === 1) addNotice('this is the only tab; /new starts over in it');
    else setTabs(closeTab(t, t.active));
  } else {
    const tab = t.tabs[Number(what) - 1];
    if (tab) return showTab(tab.session.id);
    addNotice('usage: /tab <n> | new | close');
  }
  render();
}

function setRoute(r: RoutePreference) {
  route = r;
  vscode.postMessage({ type: 'setRoute', route: r });
}

controls.addEventListener('change', (e) => {
  const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-current]');
  if (!select) return;
  const value = select.value;
  if (value === CHOOSE_MODELS) vscode.postMessage({ type: 'chooseRole', role: 'current' });
  else if (value === SAVE_DEFAULT) vscode.postMessage({ type: 'saveRoles' });
  else if (value) vscode.postMessage({ type: 'setCurrent', alias: value });
  // Until roles.updated arrives, the dropdown shows what's current, not the menu entry.
  controls.innerHTML = '';
  renderControls();
});

controls.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const r = btn.dataset.route as RoutePreference | undefined;
  if (r) {
    setRoute(r);
    render();
  } else if (btn.hasAttribute('data-agent')) vscode.postMessage({ type: 'chooseAgent' });
  else if (btn.hasAttribute('data-mode')) vscode.postMessage({ type: 'chooseMode' });
  else if (btn.hasAttribute('data-escalate-now'))
    vscode.postMessage({ type: 'command', name: 'up', args: [] });
  else if (btn.dataset.role)
    vscode.postMessage({ type: 'chooseRole', role: btn.dataset.role as RoleName });
});

// `toggle` doesn't bubble, so listen in the capture phase.
log.addEventListener(
  'toggle',
  (e) => {
    const d = e.target as HTMLDetailsElement;
    // Subagent rows and reasoning both stay as the user left them.
    const id = d.dataset?.sub ?? d.dataset?.think;
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

prompts.addEventListener('submit', (e) => {
  e.preventDefault();
  const perm = view.permissions[0];
  const input = (e.target as HTMLFormElement).querySelector('input');
  if (!perm) return;
  const feedback = input?.value.trim();
  vscode.postMessage({
    type: 'permission',
    requestId: perm.requestId,
    decision: 'deny',
    ...(feedback ? { feedback } : {}),
  });
  view = resolvePermission(view, perm.requestId, 'deny');
  render();
});

prompts.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  const perm = view.permissions[0];
  const escl = view.escalations[0];
  if (btn.dataset.perm === 'tell') {
    // Swap the buttons for a line to say what to do instead.
    const form = prompts.querySelector<HTMLFormElement>('form.feedback');
    if (form) {
      form.hidden = false;
      form.querySelector('input')?.focus();
    }
    return;
  }
  // The note's Send button submits its form (handled above). Checking the
  // form, not `btn.type`: a <button> with no type attribute is a submit button
  // even outside a form, which made every prompt button do nothing.
  if (btn.closest('form.feedback')) return;
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

// Images pasted into the composer or dropped on it go with the next prompt.
const images = new PendingImages(
  $<HTMLDivElement>('images'),
  (t) => addNotice(t),
  () => syncSend(),
);
input.addEventListener('paste', (e) => {
  if (e.clipboardData && images.add(e.clipboardData.files)) e.preventDefault();
});
const composer = input.closest('.composer') as HTMLElement;
composer.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
composer.addEventListener('drop', (e) => {
  if (e.dataTransfer && images.add(e.dataTransfer.files)) e.preventDefault();
});
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

const slash = new SlashMenu(
  menu,
  slashBtn,
  input,
  (c) => (c.group === 'Custom' ? sendPrompt(`/${c.name}`) : runCommand(c.name, [])),
  () => autosize(),
);

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
      slash.sync();
      return;
    case 'subagents':
      addNotice(formatSubagents(view, 'Expand a subagent in the chat to see what it did.'));
      return;
    case 'tab':
    case 'tabs':
      return runTabCommand(name, args);
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
  const typed = !!input.value.trim() || images.count > 0;
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
  if (view.running && !text && !images.count) {
    vscode.postMessage({ type: 'cancel' });
    return;
  }
  if ((!text && !images.count) || !connected) return;
  input.value = '';
  autosize();
  slash.close();
  // Custom commands go to the engine as prompts; it expands them.
  if (text.startsWith('/') && !slash.isCustom(text)) {
    const [name = '', ...args] = text.slice(1).split(/\s+/);
    runCommand(name, args);
    return;
  }
  sendPrompt(text, delivery);
}

/** Send a prompt with the chosen editor context. */
function sendPrompt(text: string, delivery?: 'interrupt') {
  if (!connected) return;
  const choice = {
    selection: attach.selection && !!ctx.selection,
    file: attach.file && !ctx.selection && !!ctx.file,
    problems: attach.problems && ctx.problems > 0,
  };
  const sending = images.take();
  // An image alone still needs words for the model; name what's attached.
  const prompt = text || `Attached: ${sending.map((i) => i.name).join(', ')}`;
  // A queued prompt shows in the transcript once the model reads it (queue.delivered).
  const queued = view.running && delivery !== 'interrupt';
  if (!queued)
    view = addUserPrompt(
      view,
      prompt,
      sending.map(({ name, src }) => ({ name, src })),
    );
  const sent = [
    choice.selection && ctx.selection
      ? `${ctx.selection.path}:${ctx.selection.startLine}-${ctx.selection.endLine}`
      : '',
    choice.file ? ctx.file : '',
    choice.problems ? `${ctx.problems} problems in the workspace` : '',
  ].filter(Boolean);
  if (sent.length) view = addInfo(view, sent.map((x) => `📎 ${x}`).join('\n'));
  vscode.postMessage({
    type: 'prompt',
    text: prompt,
    attach: choice,
    ...(sending.length ? { images: sending.map(({ name, data }) => ({ name, data })) } : {}),
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
  slash.sync();
  syncSend();
});
input.addEventListener('blur', () => slash.close());
input.addEventListener('keydown', (e) => {
  if (slash.key(e)) return;
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
      models = m.init.models;
      // A restarted engine starts over with one tab; the old ones are saved sessions.
      if (!tabs?.tabs.some((t) => t.session.id === m.session.id)) {
        tabs = initialTabs(m.session);
        view = activeTab(tabs).view;
      }
      break;
    case 'session': {
      const t = syncTabs();
      if (!t) break;
      const note = `new session · agent ${m.session.agent}`;
      setTabs(
        m.tab === 'new'
          ? openTab(t, m.session, addInfo(initialView(m.session.id), note))
          : // A new session starts on a clear chat; the last one stays in /resume.
            replaceActive(t, m.session, () => addInfo(initialView(m.session.id), note)),
      );
      break;
    }
    case 'event': {
      const t = syncTabs();
      if (t) setTabs(reduceTabs(t, m.event));
      if (m.event.type === 'roles.updated') rolesBy.set(m.event.sessionId, m.event.roles);
      if (m.event.type === 'config.updated' && m.event.models) models = m.event.models;
      break;
    }
    case 'roles':
      rolesBy.set(m.sessionId, m.roles);
      break;
    case 'sessions': {
      const t = syncTabs();
      if (t) setTabs(trackSessions(t, m.sessions));
      break;
    }
    case 'showDashboard':
      dashboard = true;
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
    case 'commands':
      slash.setCustom(m.commands);
      break;
    case 'history': {
      const t = syncTabs();
      if (!t) break;
      dashboard = false;
      const history = addInfo(
        fromTranscript(m.session, m.messages),
        `resumed "${m.session.title || m.session.id}"`,
      );
      setTabs(
        m.tab === 'new'
          ? openTab(t, m.session, history)
          : replaceActive(t, m.session, () => history),
      );
      break;
    }
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
