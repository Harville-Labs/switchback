/**
 * Pure HTML rendering of view items, separate from the webview's DOM wiring
 * so it can be tested. All model text is escaped or goes through the
 * sanitizing Markdown renderer.
 */
import {
  estimateLabel,
  formatReasoning,
  formatTodos,
  imageLabel,
  isQuietTool,
  permissionWhy,
  speedLabel,
  tailLines,
} from '@switchback/client/format';
import {
  type DisplayRow,
  displayRows,
  exploreSummary,
  toolResult,
  toolTitle,
} from '@switchback/client/tool-display';
import type { TodoItem, ViewItem, ViewState } from '@switchback/client/view';
import { worktreeLabel } from '@switchback/client/worktrees';
import type { PermissionDecision } from '@switchback/protocol';
import { esc, renderMarkdown } from './markdown.ts';

export { esc };

const IMAGE_SRC = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/** Lines of a reasoning preview while it streams; the full text shows once it's done. */
const THINKING_ROWS = 8;

/**
 * A model's reasoning, closed by default: click to read it. Open while it
 * streams, it keeps to its last few lines so the chat doesn't jump.
 */
function renderThinking(
  text: string,
  ctx: ViewState,
  id: string,
  streaming: boolean,
  expanded: ReadonlySet<string>,
): string {
  // Item IDs repeat across a session and its subagents; the session ID tells them apart.
  const key = `think:${ctx.sessionId}:${id}`;
  const body = formatReasoning(text);
  const shown = streaming ? tailLines(body, 80, THINKING_ROWS).join('\n') : body;
  return `<details class="thinking" data-think="${esc(key)}"${expanded.has(key) ? ' open' : ''}><summary>✻ ${streaming ? 'Thinking…' : 'Thought'}</summary><div class="reasoning">${esc(shown)}</div></details>`;
}

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
    case 'image': {
      // Only an image data URL becomes a src; anything else shows as a label.
      const src = item.src && IMAGE_SRC.test(item.src) ? item.src : undefined;
      // The thumbnail says enough; without one, the label stands in.
      const body = src
        ? `<img src="${src}" alt="${esc(item.name)}">`
        : `<span>${esc(imageLabel(item.name))}</span>`;
      return `<div class="image" title="${esc(item.name)}">${body}</div>`;
    }
    case 'route': {
      const speed =
        item.tokensPerSecond !== undefined
          ? ` · <span class="speed">${esc(speedLabel(item.tokensPerSecond))}</span>`
          : '';
      return `<div class="route ${item.tier}">${esc(item.model.model)} · ${esc(item.reason)}${speed}</div>`;
    }
    case 'assistant': {
      // Streaming text stays plain; finished messages render as Markdown.
      const streaming = ctx.running && item.id === lastAssistantId(ctx);
      const body = item.text
        ? streaming
          ? `<div class="assistant">${esc(item.text)}</div>`
          : `<div class="assistant md">${renderMarkdown(item.text)}</div>`
        : '';
      return `${item.reasoning ? renderThinking(item.reasoning, ctx, item.id, streaming && !item.text, expanded) : ''}${body}`;
    }
    case 'tool': {
      if (isQuietTool(item.name)) return '';
      const icon = item.status === 'running' ? '●' : item.status === 'ok' ? '✓' : '✗';
      const title = toolTitle(item.name, item.input);
      const result = toolResult(item, OUTPUT_ROWS);
      const lock = item.private
        ? ` <span class="private" title="${esc(item.private)}: this session now stays on local models">🔒 stays local</span>`
        : '';
      const summary = result.summary
        ? `<div class="detail${result.tone === 'error' ? ' error' : ''}">⎿ ${esc(result.summary)}</div>`
        : '';
      const output = result.body.length
        ? `<div class="output">${esc(result.body.join('\n'))}${result.more ? `\n… +${result.more} lines` : ''}</div>`
        : '';
      // Diffs fold so a long edit doesn't push the conversation away; open them to read.
      const diffKey = `diff:${ctx.sessionId}:${item.id}`;
      const diff =
        item.diff && item.status === 'ok'
          ? `<details class="tool-diff" data-think="${esc(diffKey)}"${expanded.has(diffKey) ? ' open' : ''}><summary>Show diff</summary>${renderDiff(item.diff)}</details>`
          : '';
      return `<div class="tool"><span class="${item.status}">${icon}</span> <b>${esc(title.verb)}</b> ${esc(title.target)}${lock}</div>${summary}${output}${diff}`;
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
      const branch = item.worktree
        ? ` <span class="detail worktree">${esc(worktreeLabel(item.worktree))}</span>`
        : '';
      const summary = `<span class="${item.status}">↳ ${icon} ${esc(item.agent)}</span> ${esc(item.task)} <span class="detail">${esc(meta)}</span>${branch}`;
      const child = ctx.children[item.id];
      if (!child) return `<div class="subagent">${summary}</div>`;
      // Expanded state lives in \`expanded\` so re-rendering doesn't collapse it.
      const body = renderRows(
        child.items.filter(
          (i) => !(i.kind === 'tool' && i.name === 'task' && i.status !== 'error'),
        ),
        child,
        expanded,
      );
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

/** Lines of a command's output shown under it. */
const OUTPUT_ROWS = 3;

/** Items as HTML, with runs of reading and searching folded into one "Explored" block. */
export function renderRows(
  items: readonly ViewItem[],
  ctx: ViewState,
  expanded: ReadonlySet<string>,
): string {
  return displayRows(items)
    .map((row) => renderRow(row, ctx, expanded))
    .join('');
}

function renderRow(row: DisplayRow, ctx: ViewState, expanded: ReadonlySet<string>): string {
  if (row.kind === 'item') return renderItem(row.item, ctx, expanded);
  const key = `explore:${ctx.sessionId}:${row.id}`;
  const running = row.calls.some((c) => c.status === 'running');
  const calls = row.calls
    .map((c) => {
      const t = toolTitle(c.name, c.input);
      const s = toolResult(c).summary;
      return `<li>${esc(t.verb)} <code>${esc(t.target)}</code>${s ? ` <span class="detail-inline">· ${esc(s)}</span>` : ''}</li>`;
    })
    .join('');
  return `<details class="explore" data-think="${esc(key)}"${expanded.has(key) ? ' open' : ''}><summary><span class="${running ? 'running' : 'ok'}">${running ? '●' : '✓'}</span> <b>${running ? 'Exploring' : 'Explored'}</b> <span class="detail-inline">· ${esc(exploreSummary(row.calls))}</span></summary><ul>${calls}</ul></details>`;
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
    const reason = permissionWhy(perm);
    const why = reason ? `<div class="hint">${esc(reason)}</div>` : '';
    return `<div class="prompt">Allow <b>${esc(perm.summary)}</b>?${why}${perm.preview ? renderDiff(perm.preview) : ''}<div class="actions"><button class="btn" data-perm="once">Allow once</button>${always}<button class="btn secondary" data-perm="deny">Deny</button><button class="btn secondary" data-perm="tell" title="Decline, and tell the model what to do instead">Deny with a note…</button></div><form class="feedback" hidden><input name="feedback" placeholder="What should it do instead?" autocomplete="off"><button class="btn" type="submit">Send</button></form></div>`;
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

/** Prompts waiting for the running turn's next step, each with a way to take it back. */
export function renderQueue(queue: readonly { id: string; text: string }[]): string {
  return queue
    .map(
      (q) =>
        `<div class="queued"><span class="text" title="${esc(q.text)}">⧗ ${esc(q.text)}</span><button class="link" data-dequeue="${esc(q.id)}">Withdraw</button></div>`,
    )
    .join('');
}

/** The model's checklist while there's work left on it. */
export function renderTodos(todos: readonly TodoItem[] | undefined): string {
  if (!todos?.some((t) => t.status !== 'done')) return '';
  const lines = formatTodos(todos);
  return `<div class="todos">${todos
    .map((t, i) => `<div class="todo ${t.status}">${esc(lines[i] ?? '')}</div>`)
    .join('')}</div>`;
}
