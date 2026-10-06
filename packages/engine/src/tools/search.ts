/**
 * Web search backends for the websearch tool, all treated alike: Brave's
 * Search API, Tavily (through its official SDK), and a self-hosted SearXNG.
 */
import { tavily } from '@tavily/core';
import { z } from 'zod';

export const SearchConfig = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('brave'), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal('tavily'), apiKey: z.string().min(1) }),
  z.object({ provider: z.literal('searxng'), baseUrl: z.url() }),
]);
export type SearchConfig = z.infer<typeof SearchConfig>;

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

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
