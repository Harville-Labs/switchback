/**
 * VS Code extension host. A thin client: it spawns `switchback serve --stdio`,
 * relays engine events to the chat webview, and forwards user actions back.
 * All behavior (routing, tools, permissions, agents) lives in the engine.
 */

import { chmodSync, existsSync } from 'node:fs';
import type { EngineEvent, InitializeResult, Message, RoutePreference } from '@switchback/protocol';
import * as vscode from 'vscode';
import { ChatViewProvider } from './chat-view.ts';
import { EngineConnection, NoEngineError, resolveEngine } from './connection.ts';
import { type AttachChoice, EditorContext } from './context.ts';
import { installerShell } from './engine-binary.ts';
import { chooseModels, chooseReview, chooseRewind } from './pickers.ts';
import { EditReview, PROPOSED_SCHEME } from './review.ts';

/** Returned from activate() for the integration tests; not a public API. */
export interface SwitchbackTestApi {
  connected(): boolean;
  pendingReviews(): string[];
  init(): InitializeResult | undefined;
  onEvent(listener: (event: EngineEvent) => void): vscode.Disposable;
  prompt(text: string, attach?: AttachChoice): Promise<void>;
  transcript(): Promise<Message[]>;
}

export async function activate(context: vscode.ExtensionContext): Promise<SwitchbackTestApi> {
  const bin = vscode.Uri.joinPath(
    context.extensionUri,
    'bin',
    process.platform === 'win32' ? 'switchback.exe' : 'switchback',
  ).fsPath;
  const bundled = existsSync(bin) ? bin : undefined;
  if (bundled) {
    // .vsix is a zip; installs don't always preserve the executable bit.
    if (process.platform !== 'win32') {
      try {
        chmodSync(bin, 0o755);
      } catch {
        // Read-only install location; it was installed executable or spawn will say so.
      }
    }
  }
  const log = vscode.window.createOutputChannel('Switchback');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'switchback.setRoute';
  context.subscriptions.push(log, status);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const review = new EditReview();
  const editorContext = root
    ? new EditorContext((state) => engine?.post({ type: 'context', state }))
    : undefined;
  if (editorContext) context.subscriptions.push(editorContext);
  context.subscriptions.push(
    review,
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, review),
  );
  const answerEdit = (decision: 'allow_once' | 'deny') => async (uri?: vscode.Uri) => {
    const requestId =
      review.requestIdOf(uri) ?? review.requestIdOf(vscode.window.activeTextEditor?.document.uri);
    if (!requestId) return;
    await engine?.handle({ type: 'permission', requestId, decision });
  };
  let engine: EngineConnection | undefined;
  const chat = new ChatViewProvider(context.extensionUri, (m) => engine?.handle(m));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('switchback.chat', chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const start = async () => {
    engine?.dispose();
    if (!root) {
      status.text = '$(circle-slash) Switchback';
      status.tooltip = 'Open a folder to use Switchback';
      status.show();
      return;
    }
    engine = new EngineConnection(root, log, status, review, bundled);
    engine.context = editorContext;
    engine.onMessage((m) => chat.post(m));
    try {
      await engine.start();
      // Local models are user-configured; nudge toward setup when there isn't one.
      // Never await a notification here: it resolves only when the user
      // clicks, and activation would hang until then.
      if (!engine.init?.models.some((m) => m.tier === 'local')) {
        void vscode.window
          .showInformationMessage(
            'Switchback has no local model configured, so every turn runs remotely.',
            'Set Up Models',
          )
          .then((pick) => {
            if (pick) void vscode.commands.executeCommand('switchback.runSetup');
          });
      }
    } catch (err) {
      const message = (err as Error).message;
      log.appendLine(`failed to start engine: ${message}`);
      if (err instanceof NoEngineError) {
        chat.post({
          type: 'disconnected',
          message:
            'Switchback needs its engine, the switchback CLI, which isn\'t installed. Run "Switchback: Install Terminal Command", or set "switchback.executablePath".',
        });
        void vscode.window
          .showErrorMessage(
            'Switchback needs the switchback CLI on this platform.',
            'Install Terminal Command',
            'Open Settings',
          )
          .then((pick) => {
            if (pick === 'Install Terminal Command')
              void vscode.commands.executeCommand('switchback.installCli');
            if (pick === 'Open Settings')
              void vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'switchback.executablePath',
              );
          });
        return;
      }
      chat.post({
        type: 'disconnected',
        message: `Could not start switchback: ${message}. Check the "switchback.executablePath" setting.`,
      });
      void vscode.window
        .showErrorMessage('Switchback could not start its engine.', 'Open Settings', 'Show Logs')
        .then((pick) => {
          if (pick === 'Open Settings')
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'switchback.executablePath',
            );
          if (pick === 'Show Logs') log.show();
        });
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('switchback.newSession', () => engine?.newSession()),
    vscode.commands.registerCommand('switchback.openSession', () => engine?.openSession()),
    vscode.commands.registerCommand('switchback.rewind', () => engine && chooseRewind(engine)),
    vscode.commands.registerCommand('switchback.acceptEdit', answerEdit('allow_once')),
    vscode.commands.registerCommand('switchback.rejectEdit', answerEdit('deny')),
    vscode.commands.registerCommand('switchback.cancel', () => engine?.handle({ type: 'cancel' })),
    vscode.commands.registerCommand('switchback.showUsage', () => engine?.usage()),
    vscode.commands.registerCommand('switchback.setReview', () => engine && chooseReview(engine)),
    vscode.commands.registerCommand(
      'switchback.chooseModels',
      () => engine && chooseModels(engine),
    ),
    vscode.commands.registerCommand('switchback.showReceipt', () =>
      engine?.receipt().catch((err: Error) => vscode.window.showErrorMessage(err.message)),
    ),
    vscode.commands.registerCommand('switchback.compact', () =>
      engine?.compact().catch((err: Error) => vscode.window.showErrorMessage(err.message)),
    ),
    vscode.commands.registerCommand('switchback.restartEngine', start),
    vscode.commands.registerCommand('switchback.installCli', () => {
      // The same installer as the website, so the CLI has one update path. It runs
      // where the extension runs (including remote hosts and containers); the
      // engine restarts afterwards to pick up the CLI if it's newer.
      const terminal = vscode.window.createTerminal({
        name: 'Install Switchback',
        ...installerShell(),
      });
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t !== terminal) return;
        sub.dispose();
        void start();
      });
      context.subscriptions.push(sub);
      terminal.show();
    }),
    vscode.commands.registerCommand('switchback.runSetup', async () => {
      if (!root) return;
      // Setup is interactive and shared with the CLI, so run `switchback init` in a terminal
      // and restart the engine when it closes to pick up the new config.
      let binary = engine?.binary;
      if (!binary) {
        try {
          binary = await resolveEngine(root, bundled);
        } catch (err) {
          void vscode.window.showErrorMessage((err as Error).message);
          return;
        }
      }
      const { command, args } = binary;
      const terminal = vscode.window.createTerminal({
        name: 'Switchback Setup',
        cwd: root,
        shellPath: command,
        shellArgs: [...args, 'init'],
      });
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t !== terminal) return;
        sub.dispose();
        void start();
      });
      context.subscriptions.push(sub);
      terminal.show();
    }),
    vscode.commands.registerCommand('switchback.showLogs', () => log.show()),
    vscode.commands.registerCommand('switchback.setRoute', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'auto', description: 'Start on the start model; escalate when it struggles' },
          { label: 'local', description: 'Only local models for the next prompts' },
          { label: 'remote', description: 'Only hosted models for the next prompts' },
        ],
        { title: 'Switchback routing' },
      );
      if (pick) engine?.setRoute(pick.label as RoutePreference);
    }),
    vscode.commands.registerCommand('switchback.askAboutSelection', async () => {
      if (!root || !editorContext) return;
      engine?.post({ type: 'context', state: editorContext.state() });
      await vscode.commands.executeCommand('switchback.chat.focus');
      engine?.post({ type: 'attachSelection' });
    }),
    { dispose: () => engine?.dispose() },
  );

  await start();

  return {
    connected: () => !!engine?.client,
    pendingReviews: () => review.pending(),
    init: () => engine?.init,
    onEvent: (listener) =>
      engine?.onMessage((m) => {
        if (m.type === 'event') listener(m.event);
      }) ?? new vscode.Disposable(() => {}),
    prompt: async (text, attach) => {
      await engine?.handle({ type: 'prompt', text, ...(attach ? { attach } : {}) });
    },
    transcript: async () => {
      const c = engine?.client;
      const id = engine?.session?.id;
      return c && id ? (await c.request('session.get', { sessionId: id })).messages : [];
    },
  };
}

export function deactivate() {}
