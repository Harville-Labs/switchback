import { error, redirect } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { attempt, requireActor } from '$lib/server/guards';
import { acceptInvitation, invitation } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { user } = requireActor(event);
  const inv = await invitation((await siteApp()).ctx, event.params.id);
  if (!inv) error(404, 'That invitation no longer exists.');
  return {
    invitation: { site: inv.site, role: inv.role, email: inv.email },
    usable: inv.status === 'pending' && inv.expiresAt > new Date(),
    mismatch: inv.email !== user.email,
    email: user.email,
  };
};

export const actions: Actions = {
  default: async (event) => {
    const actor = requireActor(event);
    const app = await siteApp();
    const result = await attempt(() => acceptInvitation(app.ctx, actor, event.params.id));
    if ('slug' in result) redirect(303, `/s/${result.slug}`);
    return result;
  },
};
