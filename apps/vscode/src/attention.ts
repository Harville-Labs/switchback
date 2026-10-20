/**
 * VS Code notifications when Switchback needs you or finishes a long turn,
 * shown only when you can't see the chat: the window is in the background,
 * or the chat view is closed or hidden behind another view.
 */
import { AttentionTracker, type SessionScope } from '@switchback/client';
import type { NotificationSettings } from '@switchback/protocol';
import * as vscode from 'vscode';
import type { ChatViewProvider } from './chat-view.ts';
import type { HostToWebview } from './messages.ts';

export class AttentionNotifier {
  private tracker: AttentionTracker | undefined;
  private scope: SessionScope | undefined;
  private settings: NotificationSettings | undefined;

  constructor(private readonly chat: ChatViewProvider) {}

  /** Feed it everything an engine connection broadcasts, with the sessions open in this window. */
  observe(m: HostToWebview, scope: SessionScope): void {
    // `ready` comes again whenever the webview reloads; keep the turns in flight.
    const changed =
      m.type === 'ready' && JSON.stringify(m.init.notifications) !== JSON.stringify(this.settings);
    if (m.type === 'ready') this.settings = m.init.notifications;
    if (!this.tracker || changed || scope !== this.scope) {
      this.scope = scope;
      this.tracker = new AttentionTracker(scope, this.settings);
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
