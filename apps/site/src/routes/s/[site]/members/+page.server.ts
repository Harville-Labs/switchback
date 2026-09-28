import { attempt, siteContext } from '$lib/server/guards';
import {
  changeRole,
  invite,
  listMembers,
  ROLES,
  type Role,
  removeMember,
  SiteError,
  seatsUsed,
  userById,
} from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, user } = await siteContext(event);
  const members = await listMembers(app.ctx, site);
  return {
    members: members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      role: m.role,
      status: m.status,
      devices: m.devices,
      lastSeen: m.lastSeen?.toISOString() ?? null,
    })),
    used: await seatsUsed(app.ctx, site),
    harnessManager: user.harnessManager,
  };
};

const roleOf = (v: FormDataEntryValue | null): Role => {
  if (!ROLES.includes(v as Role)) throw new SiteError('Unknown role.');
  return v as Role;
};

export const actions: Actions = {
  invite: async (event) => {
    const { app, site, user, membership } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const role = roleOf(form.get('role'));
      const invited = await invite(
        app.ctx,
        site,
        user,
        membership,
        String(form.get('email') ?? ''),
        role,
      );
      await app.mailer.send({
        to: invited.email,
        subject: `You're invited to ${site.name} on Harness`,
        text: `${user.email} invited you to ${site.name} on Harness as ${role === 'member' ? 'a member' : `an ${role}`}.\n\nSign in with this address at ${app.publicUrl}/login?next=/s/${site.slug} to accept, then connect Harness with:\n\n  harness login --site ${site.slug}\n`,
      });
      return { notice: `Invited ${invited.email}.` };
    });
  },
  role: async (event) => {
    const { app, site, user, membership } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const target = await userById(app.ctx, String(form.get('user')));
      if (!target) throw new SiteError('No such member.', 404);
      const role = roleOf(form.get('role'));
      await changeRole(app.ctx, site, user, membership, target, role);
      return { notice: `${target.email} is now ${role === 'member' ? 'a member' : `an ${role}`}.` };
    });
  },
  remove: async (event) => {
    const { app, site, user, membership } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const target = await userById(app.ctx, String(form.get('user')));
      if (!target) throw new SiteError('No such member.', 404);
      await removeMember(app.ctx, site, user, membership, target);
      return { notice: `Removed ${target.email} and signed out their devices.` };
    });
  },
};
