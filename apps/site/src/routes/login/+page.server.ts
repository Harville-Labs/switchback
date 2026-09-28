import { fail, redirect } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { safeNext } from '$lib/server/guards';
import { Email, SiteError, startSignIn, startStaffSignIn } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

const ERRORS: Record<string, string> = {
  sso: "Single sign-on didn't complete. If your account isn't set up for it, use an emailed link.",
  INVALID_TOKEN: 'That sign-in link has expired or was already used. Ask for a new one.',
  EXPIRED_TOKEN: 'That sign-in link has expired. Ask for a new one.',
};

export const load: PageServerLoad = async ({ locals, url }) => {
  if (locals.user) redirect(303, safeNext(url.searchParams.get('next')));
  const error = url.searchParams.get('error');
  return {
    next: safeNext(url.searchParams.get('next')),
    staffSso: (await siteApp()).staffSso,
    error: error ? (ERRORS[error] ?? 'Sign-in failed. Try again.') : undefined,
  };
};

export const actions: Actions = {
  signIn: async ({ request }) => {
    const form = await request.formData();
    const email = Email.safeParse(String(form.get('email') ?? ''));
    if (!email.success) return fail(400, { error: 'Enter an email address.' });
    const app = await siteApp();
    let result: Awaited<ReturnType<typeof startSignIn>>;
    try {
      result = await startSignIn(app.ctx, request.headers, {
        email: email.data,
        next: safeNext(String(form.get('next') ?? '')),
        link: form.get('link') === '1',
      });
    } catch (err) {
      if (err instanceof SiteError) return fail(err.status, { error: err.message });
      throw err;
    }
    if ('redirect' in result) redirect(303, result.redirect);
    return { sent: result.sent };
  },
  staff: async ({ request }) => {
    const form = await request.formData();
    const app = await siteApp();
    const { redirect: to } = await startStaffSignIn(
      app.ctx,
      request.headers,
      safeNext(String(form.get('next') ?? '/admin')),
    );
    redirect(303, to);
  },
};
