/**
 * Chat webview. Renders from the same view-model reducer as the TUI
 * (`@harness/client`), so both clients show identical session state.
 */
import {
  addInfo,
  addUserPrompt,
  estimateLabel,
  formatUsage,
  fromTranscript,
  initialView,
  reduce,
  resolveEscalation,
  resolvePermission,
  type ViewItem,
  type ViewState,
} from '@harness/client/view';
import type { RoutePreference } from '@harness/protocol';
import type { EditorContextState } from '../context.ts';
import type { HostToWebview, WebviewToHost } from '../messages.ts';
import { esc, renderDiff, renderItem as renderViewItem } from './render.ts';

declare function acquireVsCodeApi(): { postMessage(m: WebviewToHost): void };
const vscode = acquireVsCodeApi();

let view: ViewState = initialView('');
let route: RoutePreference = 'auto';
let connected = false;
let agents: string[] = [];

const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
<style>
  body { padding: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  #app { display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px 10px; }
  .user { margin-top: 12px; font-weight: 600; color: var(--vscode-textLink-foreground); white-space: pre-wrap; }
  .assistant { white-space: pre-wrap; margin: 4px 0; line-height: 1.45; }
  .assistant.md { white-space: normal; }
  .md p { margin: 4px 0; } .md ul, .md ol { margin: 4px 0; padding-left: 20px; }
  .md code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  .md table { border-collapse: collapse; } .md td, .md th { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; }
  .md a { color: var(--vscode-textLink-foreground); }
  .code { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 6px 0; }
  .code-bar { display: flex; justify-content: space-between; padding: 2px 6px; font-size: .8em; opacity: .8; border-bottom: 1px solid var(--vscode-panel-border); }
  .code pre { margin: 0; padding: 6px; overflow-x: auto; } .code pre code { background: none; padding: 0; }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0 4px; }
  .reasoning { opacity: .6; font-style: italic; white-space: pre-wrap; }
  .route { font-size: .85em; opacity: .75; margin: 2px 0; }
  .route.local::before { content: "⌂ "; } .route.remote::before { content: "☁ "; }
  .route.remote { color: var(--vscode-charts-yellow); } .route.local { color: var(--vscode-charts-green); }
  .tool, .subagent { font-family: var(--vscode-editor-font-family); font-size: .9em; margin: 2px 0; }
  details.subagent > summary { cursor: pointer; list-style: none; }
  details.subagent > summary::-webkit-details-marker { display: none; }
  details.subagent > .children { margin: 2px 0 6px 14px; padding-left: 8px; border-left: 1px solid var(--vscode-panel-border); }
  .ok { color: var(--vscode-charts-green); } .error { color: var(--vscode-errorForeground); } .running { color: var(--vscode-charts-yellow); }
  .detail { opacity: .7; margin-left: 1.4em; white-space: pre-wrap; }
  .info { opacity: .7; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
  .prompt { border: 1px solid var(--vscode-focusBorder); border-radius: 4px; padding: 8px; margin: 6px 10px; }
  .prompt button { margin: 6px 6px 0 0; }
  .prompt .estimate { color: var(--vscode-charts-yellow); }
  .tool .private { color: var(--vscode-charts-blue); font-size: 0.9em; }
  .review { margin: 4px 0; }
  .review.skipped { opacity: .7; }
  .review ul { margin: 2px 0 2px 1.4em; padding: 0; }
  .review li.bug { color: var(--vscode-errorForeground); }
  .review li.nit { opacity: .7; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .chip { font-size: .8em; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); opacity: .7; }
  .chip.on { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-color: transparent; opacity: 1; }
  .diff { font-family: var(--vscode-editor-font-family); font-size: .85em; max-height: 45vh; overflow: auto; margin: 6px 0; white-space: pre; border: 1px solid var(--vscode-panel-border); }
  .diff .add { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,160,0,.15)); }
  .diff .del { background: var(--vscode-diffEditor-removedLineBackground, rgba(200,0,0,.15)); }
  .diff .hunk { color: var(--vscode-textLink-foreground); opacity: .8; }
  footer { border-top: 1px solid var(--vscode-panel-border); padding: 6px 10px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; font: inherit; }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; font-size: .85em; opacity: .85; gap: 6px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 10px; border-radius: 2px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); }
</style>
<div id="log"></div>
<div id="prompts"></div>
<footer>
  <div id="chips" class="chips"></div>
  <textarea id="input" placeholder="Ask anything (Enter to send, Shift+Enter for a newline)"></textarea>
  <div class="bar">
    <span><select id="route"><option>auto</option><option>local</option><option>remote</option></select> <span id="status"></span></span>
    <span><button id="cancel" class="secondary" hidden>Cancel</button><button id="send">Send</button></span>
  </div>
</footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $<HTMLDivElement>('log');
const prompts = $<HTMLDivElement>('prompts');
const input = $<HTMLTextAreaElement>('input');
const routeSelect = $<HTMLSelectElement>('route');
const statusEl = $<HTMLSpanElement>('status');
const cancelBtn = $<HTMLButtonElement>('cancel');

/** Subagent sections the user opened; kept across re-renders. */
const expanded = new Set<string>();
const renderItem = (item: ViewItem, ctx: ViewState = view) => renderViewItem(item, ctx, expanded);

function render() {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.innerHTML = view.items.map((i) => renderItem(i)).join('');
  if (nearBottom) log.scrollTop = log.scrollHeight;

  const perm = view.permissions[0];
  const escl = view.escalations[0];
  prompts.innerHTML = perm
    ? `<div class="prompt">Allow <b>${esc(perm.summary)}</b>?${perm.preview ? renderDiff(perm.preview) : '<br>'}<button data-perm="allow_once">Allow once</button><button data-perm="allow_always" class="secondary">Always this session</button><button data-perm="deny" class="secondary">Deny</button></div>`
    : escl
      ? `<div class="prompt">Escalate to <b>${esc(escl.target.model)}</b>${escl.estimatedCostUsd !== undefined ? ` <span class="estimate">(${esc(estimateLabel(escl.estimatedCostUsd))})</span>` : ''}? ${esc(escl.reason)}<br><button data-esc="1">Use remote</button><button data-esc="0" class="secondary">Stay local</button></div>`
      : '';
  cancelBtn.hidden = !view.running;
  routeSelect.value = route;
  statusEl.textContent = connected
    ? `${view.private ? '🔒 local only · ' : ''}${view.lastTier ?? ''} $${view.costUsd.toFixed(4)}${view.savingsUsd > 0.005 ? ` · saved ~$${view.savingsUsd.toFixed(2)}` : ''}`
    : 'disconnected';
}

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
  if (btn.dataset.perm && perm) {
    const decision = btn.dataset.perm as 'allow_once' | 'allow_always' | 'deny';
    vscode.postMessage({ type: 'permission', requestId: perm.requestId, decision });
    view = resolvePermission(view, perm.requestId, decision);
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

function send() {
  const text = input.value.trim();
  if (!text || view.running || !connected) return;
  input.value = '';
  if (text.startsWith('/agent ')) {
    vscode.postMessage({ type: 'newSession', agent: text.slice(7).trim() });
    return;
  }
  const choice = {
    selection: attach.selection && !!ctx.selection,
    file: attach.file && !ctx.selection && !!ctx.file,
    problems: attach.problems && ctx.problems > 0,
  };
  view = addUserPrompt(view, text);
  const sent = [
    choice.selection && ctx.selection
      ? `${ctx.selection.path}:${ctx.selection.startLine}-${ctx.selection.endLine}`
      : '',
    choice.file ? ctx.file : '',
    choice.problems ? `problems in ${ctx.file}` : '',
  ].filter(Boolean);
  if (sent.length) view = addInfo(view, sent.map((x) => `📎 ${x}`).join('\n'));
  vscode.postMessage({ type: 'prompt', text, attach: choice });
  render();
}

$<HTMLButtonElement>('send').addEventListener('click', send);
cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
routeSelect.addEventListener('change', () =>
  vscode.postMessage({ type: 'setRoute', route: routeSelect.value as RoutePreference }),
);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      connected = true;
      route = m.route;
      agents = m.init.agents.map((a) => a.name);
      if (view.sessionId !== m.session.id)
        view = addInfo(
          initialView(m.session.id),
          `agent ${m.session.agent} · agents: ${agents.join(', ')} · type /agent <name> to switch`,
        );
      break;
    case 'session':
      view = addInfo(
        { ...initialView(m.session.id), items: view.items },
        `new session · agent ${m.session.agent}`,
      );
      break;
    case 'event':
      view = reduce(view, m.event);
      break;
    case 'route':
      route = m.route;
      break;
    case 'usage':
      view = addInfo(view, formatUsage(m.usage, 'rule'));
      break;
    case 'history':
      view = addInfo(
        fromTranscript(m.session, m.messages),
        `resumed "${m.session.title || m.session.id}"`,
      );
      break;
    case 'prefill':
      input.value = m.text + input.value;
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
