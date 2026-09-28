import { error } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { attempt, requireUser } from '$lib/server/guards';
import {
  createSite,
  Email,
  listSites,
  SiteError,
  setSeats,
  siteBySlug,
  telemetrySummary,
} from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const { ctx } = await siteApp();
  return { sites: await listSites(ctx), telemetry: await telemetrySummary(ctx) };
};

/** Actions don't run the layout load, so they check for an operator themselves. */
async function operator(event: Parameters<Actions[string]>[0]) {
  const user = requireUser(event);
  if (!user.operator) error(403, 'Harville Labs operators only.');
  return { user, app: await siteApp() };
}

export const actions: Actions = {
  create: async (event) => {
    const { user, app } = await operator(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const owner = Email.safeParse(String(form.get('owner') ?? ''));
      if (!owner.success) throw new SiteError('The owner needs a valid email address.');
      const site = await createSite(app.ctx, user, {
        slug: String(form.get('slug') ?? '').trim(),
        name: String(form.get('name') ?? ''),
        seats: Number(form.get('seats')),
        ownerEmail: owner.data,
      });
      await app.mailer.send({
        to: owner.data,
        subject: `Your Harness site for ${site.name} is ready`,
        text: `Harville Labs set up ${site.name} on Harness with ${site.seats} seats, and you're its owner.\n\nSign in at ${app.publicUrl}/login?next=/s/${site.slug} to invite your team and set your policy.\n`,
      });
      return { notice: `Created ${site.name} (${site.slug}) and emailed ${owner.data}.` };
    });
  },
  seats: async (event) => {
    const { user, app } = await operator(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const site = await siteBySlug(app.ctx, String(form.get('site')));
      if (!site) throw new SiteError('No such site.', 404);
      const seats = Number(form.get('seats'));
      await setSeats(app.ctx, user, site, seats);
      return { notice: `${site.name} now has ${seats} seats.` };
    });
  },
};
