/**
 * Pure HTML rendering of view items, separate from the webview's DOM wiring
 * so it can be tested. All model text is escaped or goes through the
 * sanitizing Markdown renderer.
 */
import { toolLabel, type ViewItem, type ViewState } from '@harness/client/view';
import { renderMarkdown } from './markdown.ts';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * One view item as HTML. `ctx` is the view that owns the item (the session or
 * a subagent's), so nested subagents render recursively from their own state.
 */
export function renderItem(item: ViewItem, ctx: ViewState, expanded: ReadonlySet<string>): string {
  switch (item.kind) {
    case 'user':
      return `<div class="user">❯ ${esc(item.text)}</div>`;
    case 'info':
      return `<div class="info">${esc(item.text)}</div>`;
    case 'route':
      return `<div class="route ${item.tier}">${esc(item.model.model)} · ${esc(item.reason)}</div>`;
    case 'assistant': {
      // Streaming text stays plain; finished messages render as Markdown.
      const streaming = ctx.running && item.id === lastAssistantId(ctx);
      const body = item.text
        ? streaming
          ? `<div class="assistant">${esc(item.text)}</div>`
          : `<div class="assistant md">${renderMarkdown(item.text)}</div>`
        : '';
      return `${item.reasoning && !item.text ? `<div class="reasoning">✻ ${esc(item.reasoning.slice(-300))}</div>` : ''}${body}`;
    }
    case 'tool': {
      const icon = item.status === 'running' ? '●' : item.status === 'ok' ? '✓' : '✗';
      const detail =
        item.status === 'error' && item.output
          ? `<div class="detail error">${esc(item.output.split('\n')[0] ?? '')}</div>`
          : '';
      const lock = item.private
        ? ` <span class="private" title="${esc(item.private)}: this session now stays on local models">🔒 stays local</span>`
        : '';
      return `<div class="tool"><span class="${item.status}">${icon}</span> ${esc(toolLabel(item.name, item.input))}${lock}</div>${detail}`;
    }
    case 'subagent': {
      const icon = item.status === 'running' ? '◌' : item.status === 'ok' ? '✓' : '✗';
      const meta = [
        item.tier,
        item.background ? 'background' : undefined,
        `${item.toolCalls} tool calls`,
        item.status === 'running' ? item.activity : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      const summary = `<span class="${item.status}">↳ ${icon} ${esc(item.agent)}</span> ${esc(item.task)} <span class="detail">${esc(meta)}</span>`;
      const child = ctx.children[item.id];
      if (!child) return `<div class="subagent">${summary}</div>`;
      // Expanded state lives in \`expanded\` so re-rendering doesn't collapse it.
      const body = child.items
        .filter((i) => !(i.kind === 'tool' && i.name === 'task' && i.status !== 'error'))
        .map((i) => renderItem(i, child, expanded))
        .join('');
      return `<details class="subagent" data-sub="${esc(item.id)}"${expanded.has(item.id) ? ' open' : ''}><summary>${summary}</summary><div class="children">${body || '<div class="detail">starting…</div>'}</div></details>`;
    }
    case 'error':
      return `<div class="error">error: ${esc(item.message)}</div>`;
  }
}

export function renderDiff(diff: string): string {
  const rows = diff
    .split('\n')
    .filter((l) => !l.startsWith('---') && !l.startsWith('+++'))
    .map((l) => {
      const cls = l.startsWith('+')
        ? 'add'
        : l.startsWith('-')
          ? 'del'
          : l.startsWith('@@')
            ? 'hunk'
            : '';
      return `<div class="${cls}">${esc(l) || '&nbsp;'}</div>`;
    });
  return `<div class="diff">${rows.join('')}</div>`;
}

export function lastAssistantId(ctx: ViewState): string | undefined {
  return ctx.items.findLast((i) => i.kind === 'assistant')?.id;
}
