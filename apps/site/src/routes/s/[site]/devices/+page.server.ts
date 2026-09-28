import { attempt, siteContext } from '$lib/server/guards';
import { listDevices, revokeDevice } from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, user, manager } = await siteContext(event);
  const devices = await listDevices(app.ctx, site, manager ? undefined : user);
  return {
    devices: devices.map((d) => ({
      ...d,
      createdAt: d.createdAt.toISOString(),
      lastSeen: d.lastSeen?.toISOString() ?? null,
    })),
  };
};

export const actions: Actions = {
  revoke: async (event) => {
    const { app, site, user, membership } = await siteContext(event);
    const id = String((await event.request.formData()).get('device'));
    return attempt(async () => {
      await revokeDevice(app.ctx, site, user, membership, id);
      return {
        notice: 'Signed out. That Harness keeps its last policy until someone signs it in again.',
      };
    });
  },
};
