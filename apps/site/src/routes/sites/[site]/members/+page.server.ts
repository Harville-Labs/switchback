import { attempt, siteContext } from '$lib/server/guards';
import {
  cancelInvitation,
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
    members: members.map((m) => ({ ...m, lastSeen: m.lastSeen?.toISOString() ?? null })),
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
    const { app, site, actor } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const invited = await invite(
        app.ctx,
        site,
        actor,
        String(form.get('email') ?? ''),
        roleOf(form.get('role')),
      );
      return { notice: `Invited ${invited.email}.` };
    });
  },
  role: async (event) => {
    const { app, site, actor } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const target = await userById(app.ctx, String(form.get('user')));
      if (!target) throw new SiteError('No such member.', 404);
      const role = roleOf(form.get('role'));
      await changeRole(app.ctx, site, actor, target, role);
      return { notice: `${target.email} is now ${role === 'member' ? 'a member' : `an ${role}`}.` };
    });
  },
  remove: async (event) => {
    const { app, site, actor } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      const target = await userById(app.ctx, String(form.get('user')));
      if (!target) throw new SiteError('No such member.', 404);
      await removeMember(app.ctx, site, actor, target);
      return { notice: `Removed ${target.email} and signed out their devices.` };
    });
  },
  uninvite: async (event) => {
    const { app, site, actor } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      await cancelInvitation(app.ctx, site, actor, String(form.get('invitation')));
      return { notice: 'Invitation canceled; its seat is free.' };
    });
  },
};
