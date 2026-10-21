import { describe, expect, test } from 'bun:test';
import { PermissionPolicy, suggestRules } from '../permissions/policy.ts';
import type { Fetch } from './search.ts';
import type { ToolContext } from './tool.ts';
import { type WebSettings, webFetchTool, webSearchTool } from './web.ts';

/** A fake web: each URL answers with a status, headers, and a body. */
function site(
  pages: Record<string, { status?: number; type?: string; body?: string; location?: string }>,
) {
  const seen: string[] = [];
  const fetcher: Fetch = async (input) => {
    const url = String(input);
    seen.push(url);
    const p = pages[url];
    if (!p) return new Response('not found', { status: 404, statusText: 'Not Found' });
    return new Response(p.body ?? '', {
      status: p.status ?? 200,
      headers: {
        ...(p.type ? { 'content-type': p.type } : {}),
        ...(p.location ? { location: p.location } : {}),
      },
    });
  };
  return { fetcher, seen };
}

const ctx = (web: Partial<WebSettings>, privateReason?: string): ToolContext => ({
  workspaceRoot: '/tmp',
  sessionId: 's',
  signal: new AbortController().signal,
  agentCatalog: [],
  web: { maxChars: 10_000, timeoutMs: 5_000, ...web },
  ...(privateReason ? { privateReason } : {}),
});

describe('webfetch', () => {
  test('HTML becomes Markdown, without scripts or styles', async () => {
    const { fetcher } = site({
      'https://docs.example.com/guide': {
        type: 'text/html; charset=utf-8',
        body: '<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Guide</h1><p>Use <code>bun test</code>.</p></body></html>',
      },
    });
    const out = await webFetchTool.run(
      { url: 'https://docs.example.com/guide' },
      ctx({ fetch: fetcher }),
    );
    expect(out).toBe('# Guide\n\nUse `bun test`.');
  });

  test('follows a redirect on the same host, reports one to another host', async () => {
    const { fetcher, seen } = site({
      'https://a.example.com/old': { status: 301, location: '/new' },
      'https://a.example.com/new': { status: 302, location: 'https://b.example.org/page' },
    });
    const out = await webFetchTool.run(
      { url: 'https://a.example.com/old' },
      ctx({ fetch: fetcher }),
    );
    expect(seen).toEqual(['https://a.example.com/old', 'https://a.example.com/new']);
    expect(out).toContain('redirects to https://b.example.org/page, on another host');
  });

  test('refuses binary content, errors, and private sessions', async () => {
    const { fetcher } = site({ 'https://x.example.com/a.png': { type: 'image/png', body: 'x' } });
    await expect(
      webFetchTool.run({ url: 'https://x.example.com/a.png' }, ctx({ fetch: fetcher })),
    ).rejects.toThrow("image/png, which isn't text");
    await expect(
      webFetchTool.run({ url: 'https://x.example.com/missing' }, ctx({ fetch: fetcher })),
    ).rejects.toThrow('answered 404 Not Found');
    await expect(
      webFetchTool.run(
        { url: 'https://x.example.com/a.png' },
        ctx({ fetch: fetcher }, 'read .env'),
      ),
    ).rejects.toThrow('holds private content (read .env)');
  });
});

describe('websearch', () => {
  test('Brave and SearXNG results, numbered', async () => {
    const { fetcher, seen } = site({
      'https://api.search.brave.com/res/v1/web/search?q=bun+test&count=2': {
        type: 'application/json',
        body: JSON.stringify({
          web: {
            results: [
              {
                title: 'Bun test',
                url: 'https://bun.sh/docs/cli/test',
                description: 'Run <strong>tests</strong>',
              },
            ],
          },
        }),
      },
      'https://search.local/search?q=bun+test&format=json': {
        type: 'application/json',
        body: JSON.stringify({
          results: [{ title: 'Bun', url: 'https://bun.sh', content: 'a runtime' }],
        }),
      },
    });
    const brave = await webSearchTool.run(
      { query: 'bun test', count: 2 },
      ctx({ fetch: fetcher, search: { provider: 'brave', apiKey: 'k' } }),
    );
    expect(brave).toBe('1. Bun test\n   https://bun.sh/docs/cli/test\n   Run tests');
    const searx = await webSearchTool.run(
      { query: 'bun test' },
      ctx({ fetch: fetcher, search: { provider: 'searxng', baseUrl: 'https://search.local' } }),
    );
    expect(searx).toContain('1. Bun\n   https://bun.sh\n   a runtime');
    expect(seen).toHaveLength(2);
  });

  test('with no backend configured, searches through Exa without a key', async () => {
    const calls: { url: string; method?: string; params?: unknown }[] = [];
    // Exa's MCP server, as far as the SDK's client needs it: initialize, then tools/call.
    const exa: Fetch = async (input, init) => {
      const url = String(input);
      if (init?.method !== 'POST') return new Response(null, { status: 405 });
      const msg = JSON.parse(String(init.body)) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      calls.push({ url, method: msg.method, params: msg.params });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const result =
        msg.method === 'initialize'
          ? {
              protocolVersion: msg.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'exa', version: '1' },
            }
          : {
              content: [
                {
                  type: 'text',
                  text: 'Title: Bun\nURL: https://bun.sh\nText: A fast\n  runtime.\n\n---\n\nTitle: N/A\nURL: https://bun.sh/docs\nText: Docs',
                },
              ],
            };
      return Response.json({ jsonrpc: '2.0', id: msg.id, result });
    };
    const out = await webSearchTool.run({ query: 'bun runtime' }, ctx({ fetch: exa }));
    expect(out).toBe(
      '1. Bun\n   https://bun.sh\n   A fast runtime.\n\n2. https://bun.sh/docs\n   https://bun.sh/docs\n   Docs',
    );
    const call = calls.find((c) => c.method === 'tools/call');
    expect(call?.url).toBe('https://mcp.exa.ai/mcp');
    expect(call?.params).toEqual({
      name: 'web_search_exa',
      arguments: { query: 'bun runtime', numResults: 8 },
    });
  });
});

describe('web rules', () => {
  const fetchOf = (url: string) => ({ name: 'webfetch', category: 'web' as const, input: { url } });
  test('domain rules, with wildcards; always grants the domain', () => {
    const p = new PermissionPolicy([
      { rule: 'webfetch(domain:*.github.com)', behavior: 'allow', source: 't' },
      { rule: 'webfetch(domain:evil.example)', behavior: 'deny', source: 't' },
    ]);
    expect(p.evaluate(fetchOf('https://docs.github.com/x'), '/')?.behavior).toBe('allow');
    expect(p.evaluate(fetchOf('https://github.com'), '/')?.behavior).toBe('allow');
    expect(p.evaluate(fetchOf('https://evil.example/a'), '/')?.behavior).toBe('deny');
    expect(p.evaluate(fetchOf('https://example.org'), '/')).toBeUndefined();
    expect(suggestRules(fetchOf('https://bun.sh/docs'))).toEqual(['webfetch(domain:bun.sh)']);
    const search = { name: 'websearch', category: 'web' as const, input: { query: 'x' } };
    expect(p.evaluate(search, '/')).toBeUndefined();
    expect(suggestRules(search)).toEqual(['websearch']);
  });
});
