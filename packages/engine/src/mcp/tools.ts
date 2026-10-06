/**
 * An MCP server's tools as switchback tools named `mcp__<server>__<tool>`,
 * plus `mcp__<server>__read_resource` for a server with resources.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { z } from 'zod';
import { type Tool, ToolError, truncate } from '../tools/tool.ts';
import type { McpServerConfig } from './config.ts';
import { fromContent, fromResource } from './content.ts';

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

type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

export interface ResourceInfo {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/** What every tool from one server shares. */
function base(server: string, cfg: McpServerConfig) {
  return {
    permission: 'mcp' as const,
    permissionKey: `mcp:${server}`,
    ...(cfg.permission ? { permissionLevel: cfg.permission } : {}),
  };
}

export function toTool(server: string, cfg: McpServerConfig, client: Client, t: ListedTool): Tool {
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(t.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    // Unusual schemas: pass arguments through and let the server validate.
    schema = z.record(z.string(), z.unknown());
  }
  return {
    ...base(server, cfg),
    name: mcpToolName(server, t.name),
    description: `${t.description ?? t.name} (MCP server "${server}")`,
    schema,
    inputSchema: t.inputSchema as Record<string, unknown>,
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
      const { text: raw, images } = fromContent(result.content, `${server} ${t.name}`);
      const text = truncate(
        raw || (result.structuredContent ? JSON.stringify(result.structuredContent) : ''),
      );
      if (result.isError) throw new ToolError(text || `${t.name} failed`);
      return images.length ? { text: text || '(images)', images } : text || '(no output)';
    },
  };
}

/** Resources listed in the tool's description, so the model knows what it can read. */
const LISTED_RESOURCES = 50;

/** Read one of a server's resources (the model's way to what `@server:uri` gives the user). */
export function readResourceTool(
  server: string,
  cfg: McpServerConfig,
  client: Client,
  resources: ResourceInfo[],
): Tool {
  const listed = resources
    .slice(0, LISTED_RESOURCES)
    .map((r) => `- ${r.uri}${r.name !== r.uri ? ` (${r.name})` : ''}`)
    .join('\n');
  const more =
    resources.length > LISTED_RESOURCES ? `\n…and ${resources.length - LISTED_RESOURCES} more` : '';
  return {
    ...base(server, cfg),
    name: mcpToolName(server, 'read_resource'),
    description: `Read a resource from the MCP server "${server}" by URI.\n${listed}${more}`,
    schema: z.object({ uri: z.string().describe('The resource URI') }),
    mutating: false,
    summarize: (input) => `${server}: read ${(input as { uri: string }).uri}`,
    run: async (input, ctx) => {
      const { uri } = input as { uri: string };
      const result = await client.readResource(
        { uri },
        { signal: ctx.signal, timeout: cfg.timeoutMs },
      );
      const parts = result.contents.map((c) => fromResource(c, `${server}:${c.uri}`));
      const text = truncate(
        parts
          .map((p) => p.text)
          .filter(Boolean)
          .join('\n'),
      );
      const images = parts.flatMap((p) => p.images);
      return images.length ? { text: text || `${uri}: image`, images } : text || '(empty)';
    },
  };
}
