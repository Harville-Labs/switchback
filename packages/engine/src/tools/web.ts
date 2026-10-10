/**
 * The web tools. `webfetch` reads a page as Markdown; `websearch` asks the
 * configured search backend. Both are in the `web` permission category, and
 * neither runs in a session holding private content: a URL or a query could
 * carry it out.
 */
import TurndownService from 'turndown';
import { z } from 'zod';
import { type Fetch, type SearchConfig, search } from './search.ts';
import { defineTool, type ToolContext, ToolError, truncate } from './tool.ts';

export interface WebSettings {
  search?: SearchConfig;
  /** Characters of a page returned at most. */
  maxChars: number;
  timeoutMs: number;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: Fetch;
}

const MAX_REDIRECTS = 5;
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
// `svg` isn't in turndown's HTML tag typings, but the filter works on any tag name.
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg' as keyof HTMLElementTagNameMap]);

function web(ctx: ToolContext): WebSettings {
  if (!ctx.web) throw new ToolError('web tools are not available here');
  if (ctx.privateReason)
    throw new ToolError(
      `This session holds private content (${ctx.privateReason}); a URL or search could carry it off this machine, so the web tools are off for it.`,
    );
  return ctx.web;
}

export const webFetchTool = defineTool({
  name: 'webfetch',
  description:
    'Fetch a web page (http or https) and return its content as Markdown. For documentation, issues, and references. Follows redirects on the same host; a redirect to another host is reported so you can fetch it if appropriate.',
  schema: z.object({
    url: z.url().describe('The full URL, including https://'),
  }),
  permission: 'web',
  mutating: false,
  summarize: (i) => `fetch ${i.url}`,
  async run(input, ctx) {
    const settings = web(ctx);
    const doFetch = settings.fetch ?? fetch;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(settings.timeoutMs)]);
    let url = new URL(input.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new ToolError(`only http and https URLs can be fetched, not ${url.protocol}`);
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': 'Switchback (+https://switchback.sh)',
          Accept: 'text/html, text/markdown, text/plain, application/json;q=0.9, */*;q=0.5',
        },
      });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, url);
        if (next.host !== url.host)
          return `${url} redirects to ${next}, on another host. Fetch that URL if it's the page you want.`;
        if (hop >= MAX_REDIRECTS) throw new ToolError(`too many redirects from ${input.url}`);
        url = next;
        continue;
      }
      if (!res.ok) throw new ToolError(`${url} answered ${res.status} ${res.statusText}`.trim());
      return truncate(await pageText(res), settings.maxChars);
    }
  },
});

/** A response as text the model can read: HTML as Markdown, text as is, nothing binary. */
async function pageText(res: Response): Promise<string> {
  const type = res.headers.get('content-type') ?? '';
  if (/html/i.test(type)) return turndown.turndown(await res.text());
  if (/^text\/|json|xml|javascript|yaml|markdown/i.test(type) || !type) return res.text();
  throw new ToolError(`the response is ${type.split(';')[0]}, which isn't text`);
}

export const webSearchTool = defineTool({
  name: 'websearch',
  description:
    'Search the web. Returns titles, URLs, and snippets; fetch a result with webfetch to read it.',
  schema: z.object({
    query: z.string().min(2),
    count: z.number().int().min(1).max(20).optional().describe('Results to return (default 8)'),
  }),
  permission: 'web',
  mutating: false,
  summarize: (i) => `search "${i.query}"`,
  async run(input, ctx) {
    const settings = web(ctx);
    if (!settings.search)
      throw new ToolError(
        'web search is not set up; configure web.search (Brave, Tavily, or SearXNG) in the Switchback config',
      );
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(settings.timeoutMs)]);
    const results = await search(
      settings.search,
      input.query,
      input.count ?? 8,
      signal,
      settings.fetch,
    );
    if (!results.length) return 'no results';
    return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
  },
});
