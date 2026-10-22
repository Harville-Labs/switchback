/**
 * Text for subagent rows: their status, the detail line both clients show,
 * the `/subagents` listing, and the `/subagent` drill-down.
 */
import { toolLabel } from './format.ts';
import type { ViewItem, ViewState } from './view.ts';

type SubagentRow = Extract<ViewItem, { kind: 'subagent' }>;

/** A subagent row's status mark: waiting for a slot, running, done, or failed. */
export function subagentIcon(status: SubagentRow['status']): string {
  return status === 'queued' ? '◷' : status === 'running' ? '◌' : status === 'ok' ? '✓' : '✗';
}

/**
 * The detail after a subagent row's task: `background · large · effort high · remote · 3 tool calls`.
 * The model is the alias the parent chose, else the one the router picked.
 */
export function subagentDetail(row: SubagentRow): string {
  if (row.status === 'queued')
    return [row.background ? 'background' : undefined, row.model, 'waiting for a free slot']
      .filter(Boolean)
      .join(' · ');
  return [
    row.background ? 'background' : undefined,
    row.model ?? row.routed,
    row.effort ? `effort ${row.effort}` : undefined,
    row.tier,
    `${row.toolCalls} tool calls`,
    row.status === 'running' ? row.activity : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Every subagent in the tree, depth-first, for numbered listings. */
export function subagentList(
  state: ViewState,
  depth = 0,
): { id: string; depth: number; row: SubagentRow }[] {
  return state.items.flatMap((it) =>
    it.kind === 'subagent'
      ? [
          { id: it.id, depth, row: it },
          ...(state.children[it.id]
            ? subagentList(state.children[it.id] as ViewState, depth + 1)
            : []),
        ]
      : [],
  );
}

/** The subagent tree as numbered lines, for `/subagents`; `hint` follows a non-empty list. */
export function formatSubagents(state: ViewState, hint = ''): string {
  const all = subagentList(state);
  if (!all.length) return 'no subagents in this session yet';
  const rows = all.map(
    (x, i) =>
      `${String(i + 1).padStart(2)}. ${'  '.repeat(x.depth)}${subagentIcon(x.row.status)} ${x.row.agent}: ${x.row.task} · ${subagentDetail(x.row)}`,
  );
  return [...rows, ...(hint ? [hint] : [])].join('\n');
}

/**
 * Plain-text drill-down of one session: its routes, tool calls, and report,
 * with nested subagents indented. Used by the TUI's `/subagent`.
 */
export function describeSession(state: ViewState, indent = ''): string {
  const lines: string[] = [];
  for (const it of state.items) {
    switch (it.kind) {
      case 'user':
        lines.push(`${indent}task: ${it.text}`);
        break;
      case 'route':
        lines.push(`${indent}${it.tier === 'local' ? '⌂' : '☁'} ${it.model.model} · ${it.reason}`);
        break;
      case 'tool': {
        // A delegation is shown by its subagent row below.
        if (it.name === 'task' && it.status !== 'error') break;
        const icon = it.status === 'running' ? '●' : it.status === 'ok' ? '✓' : '✗';
        lines.push(`${indent}${icon} ${toolLabel(it.name, it.input)}`);
        const first = it.output?.split('\n').find((l) => l.trim());
        if (first) lines.push(`${indent}    ${first.slice(0, 160)}`);
        break;
      }
      case 'assistant':
        if (it.text) lines.push(...it.text.split('\n').map((l) => `${indent}${l}`));
        break;
      case 'subagent': {
        lines.push(`${indent}↳ ${subagentIcon(it.status)} ${it.agent}: ${it.task}`);
        const child = state.children[it.id];
        if (child) lines.push(describeSession(child, `${indent}    `));
        break;
      }
      case 'error':
        lines.push(`${indent}error: ${it.message}`);
        break;
      case 'info':
        break;
    }
  }
  return lines.join('\n');
}
