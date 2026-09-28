import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({
  user: locals.user ? { email: locals.user.email, operator: locals.user.operator } : undefined,
});
