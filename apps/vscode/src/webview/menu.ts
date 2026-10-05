/** The slash command menu above the composer, as HTML. */
import type { SlashCommand } from '@switchback/client/commands';
import { esc } from './markdown.ts';

/**
 * One row per command, with a heading wherever the group changes. Filtered
 * results can interleave groups; repeating a heading then is fine, and keeps
 * the rows in match order.
 */
export function renderMenu(items: readonly SlashCommand[], active: number): string {
  if (!items.length) return '<div class="menu-empty">No matching commands</div>';
  let group = '';
  return items
    .map((c, i) => {
      const head = c.group !== group ? `<div class="menu-group">${esc(c.group)}</div>` : '';
      group = c.group;
      const args = c.args ? ` <span class="menu-args">${esc(c.args)}</span>` : '';
      return `${head}<div class="menu-item${i === active ? ' active' : ''}" role="option" aria-selected="${i === active}" data-cmd="${esc(c.name)}" data-i="${i}"><span class="menu-name">/${esc(c.name)}${args}</span><span class="menu-desc">${esc(c.description)}</span></div>`;
    })
    .join('');
}
