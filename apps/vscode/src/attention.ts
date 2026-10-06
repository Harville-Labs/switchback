/**
 * VS Code notifications when Switchback needs you or finishes a long turn,
 * shown only when you can't see the chat: the window is in the background,
 * or the chat view is closed or hidden behind another view.
 */
import { AttentionTracker } from '@switchback/client';
import * as vscode from 'vscode';
import type { ChatViewProvider } from './chat-view.ts';
import type { HostToWebview } from './messages.ts';

export class AttentionNotifier {
  private tracker = new AttentionTracker();
  private settings = '';

  constructor(private readonly chat: ChatViewProvider) {}

  /** Feed it everything the engine connection broadcasts. */
  observe(m: HostToWebview): void {
    // `ready` comes again whenever the webview reloads; keep the turns in flight.
    if (m.type === 'ready' && JSON.stringify(m.init.notifications) !== this.settings) {
      this.settings = JSON.stringify(m.init.notifications);
      this.tracker = new AttentionTracker(m.init.notifications);
    }
    if (m.type !== 'event') return;
    const a = this.tracker.observe(m.event);
    if (!a || (vscode.window.state.focused && this.chat.view?.visible)) return;
    // Not awaited: the promise settles only when the notification is dismissed.
    void vscode.window.showInformationMessage(a.message, 'Open Chat').then((pick) => {
      if (pick) void vscode.commands.executeCommand('switchback.chat.focus');
    });
  }
}
