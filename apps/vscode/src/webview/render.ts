/**
 * Pure HTML rendering of view items, separate from the webview's DOM wiring
 * so it can be tested. All model text is escaped or goes through the
 * sanitizing Markdown renderer.
 */
import { estimateLabel, toolLabel } from '@switchback/client/format';
import type { ViewItem, ViewState } from '@switchback/client/view';
import type { PermissionDecision } from '@switchback/protocol';
import { esc, renderMarkdown } from './markdown.ts';

export { esc };

/**
 * One view item as HTML. `ctx` is the view that owns the item (the session or
 * a subagent's), so nested subagents render recursively from their own state.
 */
export function renderItem(item: ViewItem, ctx: ViewState, expanded: ReadonlySet<string>): string {
  switch (item.kind) {
    case 'user':
      return `<div class="user">${esc(item.text)}</div>`;
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
    case 'review': {
      const who = esc(item.model?.model ?? 'reviewer');
      const head =
        item.verdict === 'approve'
          ? `<span class="ok">✓</span> Reviewed by ${who}: approved${item.summary ? `. ${esc(item.summary)}` : ''}`
          : item.verdict === 'revise'
            ? `<span class="running">↻</span> ${who} asked for changes${item.summary ? `: ${esc(item.summary)}` : ''}`
            : `Review skipped: ${esc(item.summary)}`;
      const issues = item.issues
        .map(
          (i) =>
            `<li class="${esc(i.severity)}"><code>${esc(i.file)}${i.line ? `:${i.line}` : ''}</code> ${esc(i.comment)}</li>`,
        )
        .join('');
      return `<div class="review ${item.verdict}">${head}${issues ? `<ul>${issues}</ul>` : ''}</div>`;
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

/** The question waiting for an answer: a permission, a plan to approve, or an escalation. */
export function renderPrompt(view: ViewState): string {
  const perm = view.permissions[0];
  if (perm?.plan)
    return `<div class="prompt plan"><div class="plan-title">Plan</div><div class="md">${renderMarkdown(perm.plan)}</div><div class="actions"><button class="btn" data-perm="once">Approve</button><button class="btn secondary" data-perm="always">Approve and accept edits</button><button class="btn secondary" data-perm="deny">Keep planning</button></div></div>`;
  if (perm) {
    const always = perm.rules
      ? `<button class="btn secondary" data-perm="always" title="${esc(perm.rules.join(', '))}">Always this session</button><button class="btn secondary" data-perm="project" title="Saved to .switchback/config.local.json">Always in this project</button>`
      : '';
    const why = perm.askRule
      ? `<div class="hint">The rule ${esc(perm.askRule)} asks every time.</div>`
      : '';
    return `<div class="prompt">Allow <b>${esc(perm.summary)}</b>?${why}${perm.preview ? renderDiff(perm.preview) : ''}<div class="actions"><button class="btn" data-perm="once">Allow once</button>${always}<button class="btn secondary" data-perm="deny">Deny</button></div></div>`;
  }
  const escl = view.escalations[0];
  if (escl)
    return `<div class="prompt">Escalate to <b>${esc(escl.target.model)}</b>${escl.estimatedCostUsd !== undefined ? ` <span class="estimate">(${esc(estimateLabel(escl.estimatedCostUsd))})</span>` : ''}? ${esc(escl.reason)}<div class="actions"><button class="btn" data-esc="1">Escalate</button><button class="btn secondary" data-esc="0">Stay on the current model</button></div></div>`;
  return '';
}

/** A prompt button's answer to a permission request. */
export function permissionAnswer(
  button: string,
): { decision: PermissionDecision; save?: 'project' } | undefined {
  switch (button) {
    case 'once':
      return { decision: 'allow_once' };
    case 'always':
      return { decision: 'allow_always' };
    case 'project':
      return { decision: 'allow_always', save: 'project' };
    case 'deny':
      return { decision: 'deny' };
    default:
      return undefined;
  }
}
