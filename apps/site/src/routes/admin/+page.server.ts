import { siteApp } from '$lib/server/context';
import { attempt, requireSwitchbackManager } from '$lib/server/guards';
import {
  createSite,
  listSites,
  listSwitchbackManagers,
  platformAuditLog,
  setSwitchbackManager,
  telemetrySummary,
} from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { ctx } = await siteApp();
  const managers = await listSwitchbackManagers(ctx);
  const log = await platformAuditLog(ctx);
  return {
    me: event.locals.user?.email,
    sites: await listSites(ctx),
    telemetry: await telemetrySummary(ctx),
    managers: managers.map((m) => m.email),
    log: log.map((e) => ({ ...e, at: e.at.toISOString() })),
  };
};

/** Actions don't run the layout load, so each checks for a Switchback manager itself. */
async function manager(event: Parameters<Actions[string]>[0]) {
  const actor = await requireSwitchbackManager(event);
  return { actor, user: actor.user, app: await siteApp() };
}

export const actions: Actions = {
  create: async (event) => {
    const { user, app } = await manager(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const operatorEmail = String(form.get('operator') ?? '');
      const site = await createSite(app.ctx, user, {
        slug: String(form.get('slug') ?? '').trim(),
        name: String(form.get('name') ?? ''),
        seats: Number(form.get('seats')),
        operatorEmail,
      });
      const to = operatorEmail.trim().toLowerCase();
      await app.mailer.send({
        to,
        subject: `Your Switchback site for ${site.name} is ready`,
        text: `Harville Labs set up ${site.name} on Switchback with ${site.seats} seats, and you're its operator.\n\nSign in at ${app.publicUrl}/login?next=/sites/${site.slug} to invite your team and set your policy.\n`,
      });
      return { notice: `Created ${site.name} (${site.slug}) and emailed ${to}.` };
    });
  },
  addManager: async (event) => {
    const { actor, user, app } = await manager(event);
    const email = String((await event.request.formData()).get('email') ?? '');
    return attempt(async () => {
      const added = await setSwitchbackManager(app.ctx, actor, email, true);
      await app.mailer.send({
        to: added.email,
        subject: "You're a Switchback manager",
        text: `${user.email} made you a Switchback manager: you can see every Switchback site, create them, and assign their operators.\n\nSign in at ${app.publicUrl}/login?next=/admin\n`,
      });
      return { notice: `${added.email} is now a Switchback manager.` };
    });
  },
  removeManager: async (event) => {
    const { actor, app } = await manager(event);
    const email = String((await event.request.formData()).get('email') ?? '');
    return attempt(async () => {
      const removed = await setSwitchbackManager(app.ctx, actor, email, false);
      return { notice: `${removed.email} is no longer a Switchback manager.` };
    });
  },
};
