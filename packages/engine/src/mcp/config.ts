/**
 * MCP server configuration, in the `mcpServers` shape most MCP clients share
 * (`command`/`args`/`env` for stdio, `url`/`headers` for HTTP).
 */
import { z } from 'zod';

const Common = {
  /** Permission for this server's tools; defaults to `permissions.mcp`. */
  permission: z.enum(['allow', 'ask', 'deny']).optional(),
  enabled: z.boolean().default(true),
  /** Per tool call. */
  timeoutMs: z.number().int().positive().default(60_000),
};

export const McpServerConfig = z.union([
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    ...Common,
  }),
  z.object({
    type: z.enum(['http', 'sse']).optional(),
    url: z.url(),
    headers: z.record(z.string(), z.string()).default({}),
    ...Common,
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfig>;

/** Server names become part of tool names (`mcp__<server>__<tool>`). */
export const McpServerName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/, 'use letters, digits, `_`, and `-` only');
