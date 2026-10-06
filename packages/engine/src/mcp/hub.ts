/**
 * Connects to the configured MCP servers with the official SDK and exposes
 * what they offer: tools (as switchback tools, see tools.ts), resources
 * (`@server:uri` in a prompt, and a read_resource tool), and prompts (as
 * `/server:prompt` commands).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpPromptInfo, McpResourceInfo } from '@switchback/protocol';
import type { Tool } from '../tools/tool.ts';
import type { McpServerConfig } from './config.ts';
import { type Converted, fromContent, fromResource } from './content.ts';
import { readResourceTool, toTool } from './tools.ts';

export { allowsMcpTool, mcpToolName } from './tools.ts';

export interface McpServerStatus {
  name: string;
  state: 'connected' | 'failed' | 'disabled';
  tools: number;
  resources?: McpResourceInfo[];
  prompts?: McpPromptInfo[];
  error?: string;
}

interface Connection {
  client: Client;
  cfg: McpServerConfig;
  tools: Tool[];
  resources: McpResourceInfo[];
  prompts: McpPromptInfo[];
}

const CONNECT_TIMEOUT_MS = 15_000;

/** Every page of a paginated MCP list. */
async function all<T>(
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  do {
    const p = await page(cursor);
    out.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
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

  /** Whether `name` is a connected server: `@name:…` and `/name:…` refer to it. */
  has(name: string): boolean {
    return this.connections.has(name);
  }

  /** A resource's contents, for `@server:uri`. */
  async readResource(server: string, uri: string): Promise<Converted> {
    const c = this.connection(server);
    const result = await c.client.readResource({ uri }, { timeout: c.cfg.timeoutMs });
    const parts = result.contents.map((r) => fromResource(r, `${server}:${r.uri}`));
    return {
      text: parts
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n'),
      images: parts.flatMap((p) => p.images),
    };
  }

  /**
   * A prompt filled in from what was typed after its name: words go to its
   * arguments in order, and the last argument takes the rest of the line.
   */
  async getPrompt(server: string, name: string, typed: string): Promise<Converted> {
    const c = this.connection(server);
    const prompt = c.prompts.find((p) => p.name === name);
    if (!prompt) throw new Error(`MCP server "${server}" has no prompt "${name}"`);
    const declared = prompt.arguments ?? [];
    const words = typed.trim() ? typed.trim().split(/\s+/) : [];
    const args: Record<string, string> = {};
    declared.forEach((a, i) => {
      const value = i === declared.length - 1 ? words.slice(i).join(' ') : words[i];
      if (value) args[a.name] = value;
    });
    const missing = declared.filter((a) => a.required && !args[a.name]);
    if (missing.length)
      throw new Error(
        `/${server}:${name} needs ${declared.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ')}`,
      );
    const result = await c.client.getPrompt(
      { name, arguments: args },
      { timeout: c.cfg.timeoutMs },
    );
    const parts = result.messages.map((m) => fromContent([m.content], `${server}:${name}`));
    return {
      text: parts
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n\n'),
      images: parts.flatMap((p) => p.images),
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connections.values()].map((c) => c.client.close()));
    this.connections.clear();
  }

  private connection(server: string): Connection {
    const c = this.connections.get(server);
    if (!c) throw new Error(`MCP server "${server}" isn't connected; see /mcp`);
    return c;
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
          this.statuses.set(name, {
            name,
            state: 'connected',
            tools: conn.tools.length,
            ...(conn.resources.length ? { resources: conn.resources } : {}),
            ...(conn.prompts.length ? { prompts: conn.prompts } : {}),
          });
          this.log(
            'info',
            `MCP server "${name}": ${conn.tools.length} tools, ${conn.resources.length} resources, ${conn.prompts.length} prompts`,
          );
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
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    await client.connect(this.transport(cfg), { signal, timeout: CONNECT_TIMEOUT_MS });
    const caps = client.getServerCapabilities() ?? {};
    const opts = { signal };
    const listed = await all(async (cursor) => {
      const p = await client.listTools(cursor ? { cursor } : undefined, opts);
      return { items: p.tools, nextCursor: p.nextCursor };
    });
    // Resources and prompts are optional capabilities; only ask servers that have them.
    const resources: McpResourceInfo[] = caps.resources
      ? await all(async (cursor) => {
          const p = await client.listResources(cursor ? { cursor } : undefined, opts);
          return {
            items: p.resources.map((r) => ({
              uri: r.uri,
              name: r.name,
              ...(r.description ? { description: r.description } : {}),
              ...(r.mimeType ? { mimeType: r.mimeType } : {}),
            })),
            nextCursor: p.nextCursor,
          };
        })
      : [];
    const prompts: McpPromptInfo[] = caps.prompts
      ? await all(async (cursor) => {
          const p = await client.listPrompts(cursor ? { cursor } : undefined, opts);
          return {
            items: p.prompts.map((x) => ({
              name: x.name,
              ...(x.description ? { description: x.description } : {}),
              ...(x.arguments?.length
                ? {
                    arguments: x.arguments.map((a) => ({
                      name: a.name,
                      ...(a.required ? { required: true } : {}),
                    })),
                  }
                : {}),
            })),
            nextCursor: p.nextCursor,
          };
        })
      : [];
    const tools = listed.map((t) => toTool(name, cfg, client, t));
    if (resources.length) tools.push(readResourceTool(name, cfg, client, resources));
    return { client, cfg, tools, resources, prompts };
  }
}
