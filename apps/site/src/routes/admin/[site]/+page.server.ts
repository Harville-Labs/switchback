import { error } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { attempt, requireHarnessManager } from '$lib/server/guards';
import {
  assignOperator,
  changeRole,
  listMembers,
  removeMember,
  SiteError,
  seatsUsed,
  setSeats,
  siteBySlug,
  userById,
} from '$lib/server/model';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

async function managed(event: RequestEvent) {
  const actor = await requireHarnessManager(event);
  const user = actor.user;
  const app = await siteApp();
  const site = await siteBySlug(app.ctx, event.params.site);
  if (!site) error(404, "There's no site with that ID.");
  return { actor, user, app, site };
}

export const load: PageServerLoad = async (event) => {
  const { app, site } = await managed(event);
  const members = await listMembers(app.ctx, site);
  return {
    site: { slug: site.slug, name: site.name, seats: site.seats, telemetry: site.telemetry },
    used: await seatsUsed(app.ctx, site),
    operators: members
      .filter((m) => m.role === 'operator')
      .map((m) => ({ id: m.id, email: m.email, status: m.status })),
    others: members.filter((m) => m.role !== 'operator').length,
  };
};

/** Find the member a form names, or say so. */
async function target(app: Awaited<ReturnType<typeof siteApp>>, form: FormData) {
  const user = await userById(app.ctx, String(form.get('user')));
  if (!user) throw new SiteError('No such member.', 404);
  return user;
}

export const actions: Actions = {
  seats: async (event) => {
    const { user, app, site } = await managed(event);
    const seats = Number((await event.request.formData()).get('seats'));
    return attempt(async () => {
      await setSeats(app.ctx, user, site, seats);
      return { notice: `${site.name} now has ${seats} seats.` };
    });
  },
  assign: async (event) => {
    const { actor, app, site } = await managed(event);
    const email = String((await event.request.formData()).get('email') ?? '');
    return attempt(async () => {
      const operator = await assignOperator(app.ctx, site, actor, email);
      await app.mailer.send({
        to: operator.email,
        subject: `You're an operator of ${site.name} on Harness`,
        text: `Harville Labs made you an operator of ${site.name} on Harness: you manage its members, policy, and devices.\n\nSign in at ${app.publicUrl}/login?next=/sites/${site.slug}\n`,
      });
      return { notice: `${operator.email} is now an operator of ${site.name}.` };
    });
  },
  demote: async (event) => {
    const { actor, app, site } = await managed(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const who = await target(app, form);
      await changeRole(app.ctx, site, actor, who, 'admin');
      return { notice: `${who.email} is now an admin of ${site.name}.` };
    });
  },
  remove: async (event) => {
    const { actor, app, site } = await managed(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const who = await target(app, form);
      await removeMember(app.ctx, site, actor, who);
      return { notice: `Removed ${who.email} from ${site.name} and signed out their devices.` };
    });
  },
};
