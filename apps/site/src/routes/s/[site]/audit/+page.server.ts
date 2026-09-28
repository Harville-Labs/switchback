import { requireManager, siteContext } from '$lib/server/guards';
import { auditLog } from '$lib/server/model';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, manager } = await siteContext(event);
  requireManager(manager);
  const entries = await auditLog(app.ctx, site);
  return { entries: entries.map((e) => ({ ...e, at: e.at.toISOString() })) };
};
