/**
 * The slash command menu above the composer: opened by the / button or by
 * typing / at the start of the input, filtered as the name is typed. It
 * lists the built-in commands and the workspace's custom ones.
 */
import {
  commandQuery,
  customCommands,
  isCustomCommand,
  matchCommands,
  type SlashCommand,
} from '@switchback/client/commands';
import type { CustomCommandInfo } from '@switchback/protocol';
import { renderMenu } from './menu.ts';

export class SlashMenu {
  private items: SlashCommand[] = [];
  private active = 0;
  private custom: SlashCommand[] = [];

  constructor(
    private readonly menu: HTMLElement,
    private readonly button: HTMLElement,
    private readonly input: HTMLTextAreaElement,
    /** Run a command picked from the menu (the input is already cleared). */
    private readonly run: (c: SlashCommand) => void,
    /** The input's text changed (to resize it). */
    private readonly changed: () => void,
  ) {
    // mousedown, not click, so the textarea keeps focus.
    menu.addEventListener('mousedown', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      if (!row) return;
      e.preventDefault();
      const c = this.items[Number(row.dataset.i)];
      if (c) this.pick(c);
    });
    menu.addEventListener('mousemove', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.menu-item');
      const i = Number(row?.dataset.i);
      if (!row || i === this.active) return;
      this.active = i;
      for (const el of menu.querySelectorAll('.menu-item'))
        el.classList.toggle('active', el === row);
    });
    // Keep focus in the input, so its blur doesn't close the menu this click toggles.
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      if (!this.menu.hidden) {
        this.close();
        input.focus();
        return;
      }
      // Like typing it: start a command unless the input already has one.
      if (!input.value.startsWith('/')) input.value = '/';
      changed();
      input.focus();
      this.sync();
    });
  }

  get open(): boolean {
    return !this.menu.hidden;
  }

  setCustom(infos: CustomCommandInfo[]): void {
    this.custom = customCommands(infos);
    if (this.open) this.sync();
  }

  /** Whether a prompt runs a custom command, which goes to the engine as a prompt. */
  isCustom(text: string): boolean {
    return isCustomCommand(text, this.custom);
  }

  /** Keep the menu in step with the input: open while it's a bare `/name`. */
  sync(): void {
    const query = commandQuery(this.input.value);
    if (query !== undefined) this.show(query);
    else if (this.open) this.close();
  }

  close(): void {
    this.menu.hidden = true;
    this.active = 0;
    this.button.classList.remove('on');
  }

  /** Arrows, Enter, Tab, and Esc while the menu is open; true when the key was used. */
  key(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (move && this.items.length) {
      e.preventDefault();
      this.active = (this.active + move + this.items.length) % this.items.length;
      this.show(commandQuery(this.input.value) ?? '');
      return true;
    }
    const c = this.items[this.active];
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      if (!c) return true;
      // Tab completes the name so arguments can follow; Enter runs it.
      if (e.key === 'Tab') this.complete(c);
      else this.pick(c);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.close();
      return true;
    }
    return false;
  }

  private show(query: string): void {
    this.items = matchCommands(query, 'vscode', this.custom);
    this.active = Math.min(this.active, Math.max(0, this.items.length - 1));
    this.menu.innerHTML = renderMenu(this.items, this.active);
    this.menu.hidden = false;
    this.button.classList.add('on');
    this.menu.querySelector('.menu-item.active')?.scrollIntoView?.({ block: 'nearest' });
  }

  private complete(c: SlashCommand): void {
    this.input.value = `/${c.name} `;
    this.changed();
    this.close();
    this.input.focus();
  }

  /** A command that needs an argument waits for it, as in the TUI; the rest run now. */
  private pick(c: SlashCommand): void {
    if (c.args?.startsWith('<')) {
      this.complete(c);
      return;
    }
    this.close();
    this.input.value = '';
    this.changed();
    this.run(c);
    this.input.focus();
  }
}
