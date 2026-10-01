import { requireSwitchbackManager } from '$lib/server/guards';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async (event) => {
  await requireSwitchbackManager(event);
};
