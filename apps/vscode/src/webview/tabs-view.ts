/** The chat's tab strip and sessions dashboard, as HTML (pure, so it can be tested). */
import { tierIcon } from '@switchback/client/format';
import { type DashboardRow, STATE_ICONS, STATE_LABELS } from '@switchback/client/tabs';
import { esc } from './render.ts';

const ICONS = {
  add: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M5 5l6 6M11 5l-6 6"/></svg>',
};

/** One tab per open session, with a state dot; then new-tab and dashboard buttons. */
export function renderTabStrip(rows: DashboardRow[], dashboard: boolean): string {
  const tabs = rows.filter((r) => r.tab);
  const elsewhere = rows.length - tabs.length;
  const items = tabs.map((r) => {
    const close =
      tabs.length > 1
        ? `<span class="x" role="button" data-close-tab="${esc(r.sessionId)}" title="Close tab (the session keeps running)" aria-label="Close tab">${ICONS.close}</span>`
        : '';
    return `<button class="tab${r.active && !dashboard ? ' on' : ''} ${r.state}" role="tab" aria-selected="${r.active && !dashboard}" data-tab="${esc(r.sessionId)}" title="${esc(`${r.title} · ${STATE_LABELS[r.state]}`)}"><span class="dot" aria-hidden="true">${r.state === 'idle' ? '' : STATE_ICONS[r.state]}</span><span class="t">${esc(r.title)}</span>${close}</button>`;
  });
  const others = elsewhere ? `<span class="badge">${elsewhere}</span>` : '';
  return `<div class="tablist" role="tablist" aria-label="Sessions">${items.join('')}</div><button class="icon" data-new-tab title="New tab" aria-label="New tab">${ICONS.add}</button><button class="icon${dashboard ? ' on' : ''}" data-dashboard title="All sessions: open tabs and ones working in other windows" aria-label="Sessions dashboard" aria-pressed="${dashboard}">${ICONS.grid}${others}</button>`;
}

/** Every open tab, then sessions working in other windows, one card each. */
export function renderDashboard(rows: DashboardRow[]): string {
  const card = (r: DashboardRow) => {
    const model = r.model
      ? `<span class="${r.tier === 'local' ? 'local' : 'remote'}">${tierIcon(r.tier)} ${esc(r.model)}</span>`
      : '';
    const facts = [
      `<span class="state ${r.state}">${STATE_ICONS[r.state]} ${STATE_LABELS[r.state]}</span>`,
      model,
      r.doing ? esc(r.doing) : '',
      r.costUsd >= 0.0005 ? `$${r.costUsd.toFixed(3)}` : '',
    ].filter(Boolean);
    const action = r.tab ? (r.active ? 'Showing' : 'Switch') : 'Open';
    return `<li class="card${r.active ? ' on' : ''}"><button class="open" data-tab="${esc(r.sessionId)}"><span class="title">${r.tab ? `<span class="n">${r.tab}</span>` : ''}${esc(r.title)}</span><span class="facts">${facts.join(' · ')}</span><span class="agent">${esc(r.agent)}</span></button><span class="actions"><button class="btn secondary" data-tab="${esc(r.sessionId)}">${action}</button>${r.tab && rows.filter((x) => x.tab).length > 1 ? `<button class="btn secondary" data-close-tab="${esc(r.sessionId)}" title="The session keeps running">Close</button>` : ''}</span></li>`;
  };
  const open = rows.filter((r) => r.tab);
  const elsewhere = rows.filter((r) => !r.tab);
  return `<div class="dash-head"><h2>Sessions</h2><button class="btn" data-new-tab>New tab</button></div><ul class="cards">${open.map(card).join('')}</ul>${
    elsewhere.length
      ? `<h3>Working in other windows</h3><ul class="cards">${elsewhere.map(card).join('')}</ul>`
      : ''
  }<p class="hint">Closing a tab doesn't stop its session: a running turn goes on and stays here. Saved sessions are under history.</p>`;
}
