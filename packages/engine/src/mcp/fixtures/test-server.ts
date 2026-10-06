/**
 * A tiny MCP server for tests, built with the official SDK: tools `add`
 * (read-only), `note` (writes a file named by NOTE_FILE), `fail` (reports an
 * error), and `pic` (returns an image); resources `test://readme` (text) and
 * `test://dot` (an image); and a prompt `review` with arguments.
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
/** A 1×1 PNG. */
const DOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
server.registerTool('pic', { description: 'Draw a dot' }, async () => ({
  content: [
    { type: 'text', text: 'a dot' },
    { type: 'image', data: DOT, mimeType: 'image/png' },
  ],
}));
server.registerResource(
  'readme',
  'test://readme',
  { description: 'The readme', mimeType: 'text/markdown' },
  async (uri) => ({ contents: [{ uri: uri.href, text: '# Test server\nIt adds numbers.' }] }),
);
server.registerResource('dot', 'test://dot', { mimeType: 'image/png' }, async (uri) => ({
  contents: [{ uri: uri.href, blob: DOT, mimeType: 'image/png' }],
}));
server.registerPrompt(
  'review',
  {
    description: 'Review a file',
    argsSchema: { file: z.string(), focus: z.string().optional() },
  },
  ({ file, focus }) => ({
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: `Review ${file}${focus ? `, focusing on ${focus}` : ''}.` },
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
