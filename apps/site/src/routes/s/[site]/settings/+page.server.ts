import { attempt, requireManager, siteContext } from '$lib/server/guards';
import { type Site, SiteError, setTelemetry } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { site, manager } = await siteContext(event);
  requireManager(manager);
  return { telemetry: site.telemetry };
};

export const actions: Actions = {
  telemetry: async (event) => {
    const { app, site, user, membership, manager } = await siteContext(event);
    requireManager(manager);
    const value = String((await event.request.formData()).get('telemetry'));
    return attempt(async () => {
      if (!['on', 'off', 'user'].includes(value)) throw new SiteError('Unknown setting.');
      await setTelemetry(app.ctx, site, user, membership, value as Site['telemetry']);
      return { notice: 'Saved. Members pick it up with their next policy refresh.' };
    });
  },
};
