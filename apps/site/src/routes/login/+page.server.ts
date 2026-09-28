import { fail, redirect } from '@sveltejs/kit';
import { siteApp } from '$lib/server/context';
import { safeNext } from '$lib/server/guards';
import { createLoginLink, Email, userByEmail } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
  if (locals.user) redirect(303, safeNext(url.searchParams.get('next')));
  return { next: safeNext(url.searchParams.get('next')) };
};

export const actions: Actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const email = Email.safeParse(String(form.get('email') ?? ''));
    if (!email.success) return fail(400, { error: 'Enter an email address.' });
    const app = await siteApp();
    // The same answer whether or not the address is known, so it can't be probed.
    if (await userByEmail(app.ctx, email.data)) {
      const token = await createLoginLink(
        app.ctx,
        email.data,
        safeNext(String(form.get('next') ?? '')),
      );
      await app.mailer.send({
        to: email.data,
        subject: 'Sign in to Harness',
        text: `Sign in to Harness:\n\n${app.publicUrl}/auth?token=${token}\n\nThe link works once and expires in 15 minutes. If you didn't ask for it, ignore this email.`,
      });
    }
    return { sent: email.data };
  },
};
