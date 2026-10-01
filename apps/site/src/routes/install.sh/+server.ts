import script from '../../../../../scripts/install.sh?raw';
import type { RequestHandler } from './$types';

/** `curl -fsSL https://harness.harville.ai/install.sh | sh`; plain text so browsers show it. */
export const GET: RequestHandler = () =>
  new Response(script, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
