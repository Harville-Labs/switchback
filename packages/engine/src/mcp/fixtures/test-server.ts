/**
 * A tiny MCP server for tests, built with the official SDK: `add` (read-only),
 * `note` (writes a file named by NOTE_FILE), and `fail` (reports an error).
 */
import { writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'test', version: '1.0.0' });
server.registerTool(
  'add',
  {
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
    annotations: { readOnlyHint: true },
  },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
);
server.registerTool(
  'note',
  { description: 'Save a note', inputSchema: { text: z.string() } },
  async ({ text }) => {
    writeFileSync(process.env.NOTE_FILE ?? 'note.txt', text);
    return { content: [{ type: 'text', text: 'saved' }] };
  },
);
server.registerTool('fail', { description: 'Always fails' }, async () => ({
  content: [{ type: 'text', text: 'something broke' }],
  isError: true,
}));
await server.connect(new StdioServerTransport());
