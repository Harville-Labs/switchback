import { fail } from '@sveltejs/kit';
import { siteContext } from '$lib/server/guards';
import { decideDevice, pendingDevice, SiteError } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, actor, membership } = await siteContext(event, { allowOutsiders: true });
  const email = actor.user.email;
  const code = event.url.searchParams.get('user_code');
  const outsider = membership
    ? null
    : `${email} isn't a member of ${site.name}. Ask one of its operators to invite you.`;
  if (!code) return { email, code: null, problem: outsider };
  const pending = await pendingDevice(app.ctx, site, actor, code);
  if (!pending)
    return {
      email,
      code: null,
      problem: 'That code has expired or was already used. Run `switchback login` again.',
    };
  return { email, code: pending.userCode, problem: outsider };
};

export const actions: Actions = {
  default: async (event) => {
    const { app, site, actor } = await siteContext(event, { allowOutsiders: true });
    const form = await event.request.formData();
    const approve = form.get('decision') === 'approve';
    try {
      await decideDevice(app.ctx, site, actor, String(form.get('code') ?? ''), approve);
    } catch (err) {
      if (err instanceof SiteError) return fail(err.status, { error: err.message });
      throw err;
    }
    return { done: approve ? ('approved' as const) : ('denied' as const) };
  },
};
