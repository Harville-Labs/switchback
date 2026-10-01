import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** The console has no front page: Switchback itself is introduced at harville.ai/switchback. */
export const load: PageServerLoad = ({ locals }) => {
  redirect(303, locals.user ? '/sites' : '/login');
};
