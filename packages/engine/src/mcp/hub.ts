/**
 * Connects to the configured MCP servers with the official SDK and exposes
 * their tools as switchback tools named `mcp__<server>__<tool>` (Claude Code's
 * naming, so agent files that list MCP tools work in both).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { type Tool, ToolError, truncate } from '../tools/tool.ts';
import type { McpServerConfig } from './config.ts';

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'failed' | 'disabled';
  tools: number;
  error?: string;
}

interface Connection {
  client: Client;
  tools: Tool[];
}

const CONNECT_TIMEOUT_MS = 15_000;
/** Providers limit tool names to 64 characters of [a-zA-Z0-9_-]. */
const MAX_TOOL_NAME = 64;

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME);
}

/** Whether an agent's `tools` entry allows this MCP tool (`mcp__srv__tool` or all of `mcp__srv`). */
export function allowsMcpTool(allowed: string[], toolName: string): boolean {
  return allowed.some(
    (a) => a === toolName || (a.startsWith('mcp__') && toolName.startsWith(`${a}__`)),
  );
}

/** Text of an MCP tool result; non-text content is described, not dropped silently. */
export function resultText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(
      (c: {
        type?: string;
        text?: string;
        resource?: { uri?: string; text?: string };
        mimeType?: string;
      }) => {
        if (c.type === 'text') return c.text ?? '';
        if (c.type === 'resource') return c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`;
        if (c.type === 'resource_link') return `[resource ${(c as { uri?: string }).uri ?? ''}]`;
        return `[${c.type ?? 'unknown'} content${c.mimeType ? ` (${c.mimeType})` : ''} omitted]`;
      },
    )
    .join('\n');
}

export class McpHub {
  private connections = new Map<string, Connection>();
  private statuses = new Map<string, McpServerStatus>();
  readonly ready: Promise<void>;

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly workspaceRoot: string,
    private readonly log: (level: 'info' | 'warn', message: string) => void = () => {},
  ) {
    this.ready = this.connectAll();
  }

  status(): McpServerStatus[] {
    return Object.keys(this.servers).map(
      (name) => this.statuses.get(name) ?? { name, state: 'failed', tools: 0, error: 'connecting' },
    );
  }

  /** Every connected server's tools, sorted by name so the tool list (and prompt cache) is stable. */
  tools(): Tool[] {
    return [...this.connections.values()]
      .flatMap((c) => c.tools)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.client.close()));
    this.connections.clear();
  }

  private async connectAll(): Promise<void> {
    await Promise.allSettled(
      Object.entries(this.servers).map(async ([name, cfg]) => {
        if (!cfg.enabled) {
          this.statuses.set(name, { name, state: 'disabled', tools: 0 });
          return;
        }
        try {
          const conn = await this.connect(name, cfg);
          this.connections.set(name, conn);
          this.statuses.set(name, { name, state: 'connected', tools: conn.tools.length });
          this.log('info', `MCP server "${name}": ${conn.tools.length} tools`);
        } catch (err) {
          const error = (err as Error).message;
          this.statuses.set(name, { name, state: 'failed', tools: 0, error });
          this.log('warn', `MCP server "${name}" failed to start: ${error}`);
        }
      }),
    );
  }

  private transport(cfg: McpServerConfig): Transport {
    if ('command' in cfg) {
      return new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        // The SDK's safe default environment plus what the config sets; the
        // rest of the user's environment (API keys) is not passed along.
        env: { ...getDefaultEnvironment(), ...cfg.env },
        cwd: cfg.cwd ?? this.workspaceRoot,
        // stdout is the MCP channel; the server's logs must not reach ours.
        stderr: 'ignore',
      });
    }
    const url = new URL(cfg.url);
    const requestInit = { headers: cfg.headers };
    return cfg.type === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }

  private async connect(name: string, cfg: McpServerConfig): Promise<Connection> {
    const client = new Client({ name: 'switchback', version: '1' });
    const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    await client.connect(this.transport(cfg), { signal: timeout, timeout: CONNECT_TIMEOUT_MS });
    const listed: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, {
        signal: timeout,
      });
      listed.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    const tools = listed.map((t) => this.toTool(name, cfg, client, t));
    return { client, tools };
  }

  private toTool(
    server: string,
    cfg: McpServerConfig,
    client: Client,
    t: Awaited<ReturnType<Client['listTools']>>['tools'][number],
  ): Tool {
    let schema: z.ZodType;
    try {
      schema = z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
    } catch {
      // Unusual schemas: pass arguments through and let the server validate.
      schema = z.record(z.string(), z.unknown());
    }
    const name = mcpToolName(server, t.name);
    return {
      name,
      description: `${t.description ?? t.name} (MCP server "${server}")`,
      schema,
      inputSchema: t.inputSchema as Record<string, unknown>,
      permission: 'mcp',
      permissionKey: `mcp:${server}`,
      ...(cfg.permission ? { permissionLevel: cfg.permission } : {}),
      // Only tools the server marks read-only run in parallel.
      mutating: t.annotations?.readOnlyHint !== true,
      summarize: (input) => {
        const args = JSON.stringify(input ?? {});
        return `${server}: ${t.name} ${args.length > 100 ? `${args.slice(0, 100)}…` : args}`;
      },
      run: async (input, ctx) => {
        const result = await client.callTool(
          { name: t.name, arguments: (input ?? {}) as Record<string, unknown> },
          undefined,
          { signal: ctx.signal, timeout: cfg.timeoutMs },
        );
        const text = truncate(
          resultText(result.content) ||
            (result.structuredContent ? JSON.stringify(result.structuredContent) : ''),
        );
        if (result.isError) throw new ToolError(text || `${t.name} failed`);
        return text || '(no output)';
      },
    };
  }
}
