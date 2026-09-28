import { siteApp } from '$lib/server/context';
import { requireActor } from '$lib/server/guards';
import { invitationsFor, sitesOf } from '$lib/server/model';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { user } = requireActor(event);
  const { ctx } = await siteApp();
  const sites = await sitesOf(ctx, user);
  return {
    sites: sites.map((s) => ({ slug: s.slug, name: s.name, role: s.role })),
    invitations: await invitationsFor(ctx, user),
  };
};
