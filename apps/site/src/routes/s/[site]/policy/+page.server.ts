import { fail } from '@sveltejs/kit';
import { attempt, requireManager, siteContext } from '$lib/server/guards';
import {
  currentPolicy,
  policyHistory,
  policyVersion,
  SiteError,
  savePolicy,
} from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, manager } = await siteContext(event);
  requireManager(manager);
  const current = await currentPolicy(app.ctx, site);
  const history = await policyHistory(app.ctx, site);
  return {
    version: current.version,
    text: JSON.stringify(current.body, null, 2),
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
  };
};

export const actions: Actions = {
  save: async (event) => {
    const { app, site, user, membership, manager } = await siteContext(event);
    requireManager(manager);
    const form = await event.request.formData();
    const text = String(form.get('policy') ?? '');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      return fail(400, { text, problems: [`Not valid JSON: ${(err as Error).message}`] });
    }
    const r = await savePolicy(
      app.ctx,
      site,
      user,
      membership,
      body,
      String(form.get('note') ?? ''),
    );
    if ('problems' in r) return fail(400, { text, problems: r.problems });
    return { notice: `Saved version ${r.version}. Members get it within their refresh interval.` };
  },
  restore: async (event) => {
    const { app, site, user, membership, manager } = await siteContext(event);
    requireManager(manager);
    const version = Number((await event.request.formData()).get('version'));
    return attempt(async () => {
      const body = await policyVersion(app.ctx, site, version);
      if (!body) throw new SiteError('No such version.', 404);
      const r = await savePolicy(
        app.ctx,
        site,
        user,
        membership,
        body,
        `restored version ${version}`,
      );
      if ('problems' in r) throw new SiteError(r.problems.join('; '));
      return { notice: `Restored version ${version} as version ${r.version}.` };
    });
  },
};
