import { fail } from '@sveltejs/kit';
import { siteContext } from '$lib/server/guards';
import { decideDevice, pendingDevice, SiteError } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, user, membership } = await siteContext(event, { allowOutsiders: true });
  const code = event.url.searchParams.get('code');
  const member = membership?.status === 'active';
  const outsider = member
    ? null
    : `${user.email} isn't a member of ${site.name}. Ask one of its admins to invite you.`;
  if (!code) return { email: user.email, code: null, client: null, problem: outsider };
  const pending = await pendingDevice(app.ctx, site, code);
  if (!pending)
    return {
      email: user.email,
      code: null,
      client: null,
      problem: 'That code has expired or was already used. Run `harness login` again.',
    };
  return { email: user.email, code: pending.userCode, client: pending.client, problem: outsider };
};

export const actions: Actions = {
  default: async (event) => {
    const { app, site, user } = await siteContext(event, { allowOutsiders: true });
    const form = await event.request.formData();
    const approve = form.get('decision') === 'approve';
    try {
      await decideDevice(app.ctx, site, user, String(form.get('code') ?? ''), approve);
    } catch (err) {
      if (err instanceof SiteError) return fail(err.status, { error: err.message });
      throw err;
    }
    return { done: approve ? ('approved' as const) : ('denied' as const) };
  },
};
