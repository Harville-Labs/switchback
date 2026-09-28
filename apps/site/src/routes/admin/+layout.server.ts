import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/guards';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = (event) => {
  if (!requireUser(event).operator) error(403, 'Harville Labs operators only.');
};
