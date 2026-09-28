import { siteApp } from '$lib/server/context';
import { requireUser } from '$lib/server/guards';
import { sitesOf } from '$lib/server/model';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const user = requireUser(event);
  const sites = await sitesOf((await siteApp()).ctx, user);
  return { sites: sites.map((s) => ({ slug: s.slug, name: s.name, role: s.role })) };
};
