import { siteContext } from '$lib/server/guards';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
  // The device page explains non-membership itself; every other page requires it.
  const ctx = await siteContext(event, { allowOutsiders: event.route.id?.endsWith('/device') });
  return {
    site: { slug: ctx.site.slug, name: ctx.site.name, seats: ctx.site.seats },
    manager: ctx.manager,
    role: ctx.membership?.role ?? null,
    switchbackManager: ctx.user.switchbackManager,
  };
};
