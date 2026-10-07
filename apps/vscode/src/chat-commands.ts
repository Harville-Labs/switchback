/**
 * Slash commands typed in the chat. Ones that show something print it into
 * the chat as the TUI does; ones that change something open the same pickers
 * as the command palette, since a picker beats typing model names.
 */
import {
  escalateNotice,
  formatMcpServers,
  formatModels,
  formatPermissions,
  formatReceipt,
  formatShells,
  formatUsage,
  parseMode,
} from '@switchback/client';
import * as vscode from 'vscode';
import type { EngineConnection } from './connection.ts';
import { chooseAgent, chooseMode, chooseModels, chooseRewind, chooseRole } from './pickers.ts';

export async function runChatCommand(
  engine: EngineConnection,
  name: string,
  args: string[],
): Promise<void> {
  const { client: c, session } = engine;
  if (!c || !session) return;
  const info = (text: string) => engine.post({ type: 'info', text });
  switch (name) {
    case 'new':
      return engine.newSession();
    case 'agent':
      return args[0] ? engine.newSession(args[0]) : chooseAgent(engine);
    case 'agents': {
      const agents = await c.request('agents.list', {}).catch(() => engine.init?.agents ?? []);
      return info(
        agents
          .map(
            (a) =>
              `${a.name} [${a.source}${a.route !== 'auto' ? `, ${a.route}` : ''}]: ${a.description}`,
          )
          .join('\n'),
      );
    }
    case 'sessions':
    case 'resume':
      return engine.openSession();
    case 'rewind':
      return chooseRewind(engine);
    case 'compact':
      return engine.compact();
    case 'models':
      return info(formatModels(engine.init?.models ?? [], await engine.currentRoles()));
    case 'roles':
      return args[0] === 'reset' ? chooseRole(engine, 'reset') : chooseModels(engine);
    case 'start':
    case 'escalate':
      return chooseRole(engine, name);
    case 'subagent-model':
      return chooseRole(engine, 'subagents');
    case 'review': {
      const next = { on: true, off: false, default: undefined } as const;
      if (!args[0] || !(args[0] in next)) return chooseRole(engine, 'review');
      engine.remoteReview = next[args[0] as keyof typeof next];
      return info(
        engine.remoteReview === undefined
          ? 'review: following review.mode in config'
          : `review: ${engine.remoteReview ? 'on' : 'off'}`,
      );
    }
    case 'usage': {
      const u = await c.request('usage.get', { period: 'week' });
      const by = (['rule', 'agent', 'model'] as const).find((b) => b === args[0]) ?? 'rule';
      return info(formatUsage(u, by));
    }
    case 'receipt': {
      const u = await c.request('usage.get', { sessionId: session.id });
      return info(formatReceipt(u, 'This session, including subagents'));
    }
    case 'mode': {
      const mode = args[0] ? parseMode(args[0]) : undefined;
      if (!mode) return chooseMode(engine);
      await c
        .request('session.setMode', { sessionId: session.id, mode })
        .catch((err: Error) => info(`mode: ${err.message}`));
      return;
    }
    case 'permissions':
      return info(
        formatPermissions(await c.request('permissions.list', { sessionId: session.id })),
      );
    case 'shells': {
      if (args[0] === 'kill' && args[1]) {
        const shell = await c.request('shells.kill', { shellId: args[1] });
        return info(`${shell.id} ${shell.status === 'killed' ? 'stopped' : 'had already exited'}`);
      }
      return info(formatShells(await c.request('shells.list', {})));
    }
    case 'up': {
      const { when } = await c.request('session.escalate', { sessionId: session.id });
      return info(escalateNotice(when));
    }
    case 'mcp': {
      const { servers } = await c.request('mcp.list', {});
      return info(`MCP servers\n${formatMcpServers(servers)}`);
    }
    case 'setup':
      await vscode.commands.executeCommand('switchback.runSetup');
      return;
    case 'logs':
      await vscode.commands.executeCommand('switchback.showLogs');
      return;
    case 'restart':
      await vscode.commands.executeCommand('switchback.restartEngine');
      return;
    default:
      return info(`unknown command /${name}; type / to see commands`);
  }
}
