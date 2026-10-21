/**
 * Switchback's own tools (subagents, escalate, docs, skills) served over MCP
 * to a coding agent CLI working a turn (Claude Code, Codex), so it can use
 * them the way any model in the session does. It listens on loopback for the
 * length of one turn and answers only requests that carry its random token.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ToolSpec } from '@switchback/providers';

/** The server's name, so its tools reach the CLI as `mcp__switchback__<tool>`. */
export const TOOL_SERVER_NAME = 'switchback';

export interface ToolServer {
  url: string;
  headers: Record<string, string>;
  close(): void;
}

export function serveTools(
  specs: ToolSpec[],
  call: (name: string, input: unknown) => Promise<{ content: string; isError?: boolean }>,
): ToolServer {
  const token = crypto.randomUUID();
  // Stateless: a fresh server and transport per request, so a CLI that
  // reconnects mid-turn never finds a stale session.
  const handle = async (req: Request) => {
    const server = new Server(
      { name: TOOL_SERVER_NAME, version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: specs.map((s) => ({
        name: s.name,
        description: s.description,
        inputSchema: { type: 'object' as const, ...s.inputSchema },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const result = await call(r.params.name, r.params.arguments ?? {});
      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // A subagent can run far longer than Bun's default 10 second idle timeout.
    idleTimeout: 0,
    fetch: (req) =>
      req.headers.get('authorization') === `Bearer ${token}`
        ? handle(req)
        : new Response('unauthorized', { status: 401 }),
  });
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    close: () => void http.stop(true),
  };
}
