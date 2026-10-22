/**
 * Web search backends for the websearch tool, all treated alike: Exa (its
 * hosted MCP server, which answers without a key), Brave's Search API, Tavily
 * (through its official SDK), and a self-hosted SearXNG.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tavily } from '@tavily/core';
import { z } from 'zod';

export const SearchConfig = z.discriminatedUnion('provider', [
  // A key only raises Exa's rate limits.
  z.object({ provider: z.literal('exa'), apiKey: z.string().min(1).optional() }),
  z.object({ provider: z.literal('brave'), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal('tavily'), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal('searxng'), baseUrl: z.url() }),
]);
export type SearchConfig = z.infer<typeof SearchConfig>;

/** Used when `web.search` isn't set, so search works out of the box; each search still asks first. */
export const DEFAULT_SEARCH: SearchConfig = { provider: 'exa' };

const EXA_MCP = 'https://mcp.exa.ai/mcp';
/** Exa returns page text; a snippet is enough, and webfetch reads the rest. */
const SNIPPET_CHARS = 500;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function search(
  config: SearchConfig,
  query: string,
  count: number,
  signal: AbortSignal,
  fetcher: Fetch = fetch,
): Promise<SearchResult[]> {
  switch (config.provider) {
    case 'exa': {
      const url = new URL(EXA_MCP);
      if (config.apiKey) url.searchParams.set('exaApiKey', config.apiKey);
      const client = new Client({ name: 'switchback', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetcher }), { signal });
      try {
        const r = await client.callTool(
          { name: 'web_search_exa', arguments: { query, numResults: count } },
          undefined,
          { signal },
        );
        if (r.isError) throw new Error(`Exa answered with an error: ${textOf(r.content)}`);
        return parseExa(textOf(r.content));
      } finally {
        await client.close();
      }
    }
    case 'brave': {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));
      const body = (await json(
        await fetcher(url, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey },
          signal,
        }),
        'Brave Search',
      )) as { web?: { results?: { title: string; url: string; description?: string }[] } };
      return (body.web?.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: stripTags(r.description ?? ''),
      }));
    }
    case 'tavily': {
      const r = await tavily({ apiKey: config.apiKey }).search(query, { maxResults: count });
      return r.results.map((x) => ({ title: x.title, url: x.url, snippet: x.content }));
    }
    case 'searxng': {
      const url = new URL(
        'search',
        config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`,
      );
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      const body = (await json(await fetcher(url, { signal }), 'SearXNG')) as {
        results?: { title: string; url: string; content?: string }[];
      };
      return (body.results ?? [])
        .slice(0, count)
        .map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
    }
  }
}

async function json(res: Response, name: string): Promise<unknown> {
  if (!res.ok)
    throw new Error(
      `${name} answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check web.search.apiKey)' : ''}`,
    );
  return res.json();
}

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text : ''))
        .join('')
    : '';
}

/** Exa's results are text blocks of `Title:`, `URL:`, then the page's text, split by `---`. */
function parseExa(text: string): SearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
    if (!url) return [];
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const body = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim() ?? '';
    const snippet = body.replace(/\s+/g, ' ');
    return [
      {
        title: title && title !== 'N/A' ? title : url,
        url,
        snippet: snippet.length > SNIPPET_CHARS ? `${snippet.slice(0, SNIPPET_CHARS)}…` : snippet,
      },
    ];
  });
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
