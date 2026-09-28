import { siteContext } from '$lib/server/guards';
import { seatsUsed, usageSummary } from '$lib/server/model';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, user, site, manager } = await siteContext(event);
  return {
    // Members see their own usage; operators and admins see everyone's.
    own: !manager,
    usage: await usageSummary(app.ctx, site, 30, manager ? undefined : user),
    seats: { used: await seatsUsed(app.ctx, site), total: site.seats },
  };
};
