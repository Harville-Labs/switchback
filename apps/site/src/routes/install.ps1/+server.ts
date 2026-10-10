import script from '../../../../../scripts/install.ps1?raw';
import type { RequestHandler } from './$types';

/** `irm https://switchback.sh/install.ps1 | iex`; plain text so browsers show it. */
export const GET: RequestHandler = () =>
  new Response(script, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
