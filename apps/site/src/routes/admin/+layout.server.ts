import { requireHarnessManager } from '$lib/server/guards';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = (event) => {
  requireHarnessManager(event);
};
