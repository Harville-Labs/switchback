import { siteProviderId } from '$lib/server/auth';
import { attempt, requireManager, siteContext } from '$lib/server/guards';
import {
  configureSso,
  removeSso,
  type Site,
  SiteError,
  setSsoRequired,
  setTelemetry,
  siteSso,
  verifySsoDomain,
} from '$lib/server/model';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  const { app, site, manager, membership } = await siteContext(event);
  requireManager(manager);
  return {
    telemetry: site.telemetry,
    ssoRequired: site.ssoRequired,
    sso: (await siteSso(app.ctx, site)) ?? null,
    // SSO is set up by the site's own operators and admins, signed in as members.
    canSetUpSso: membership?.role === 'operator' || membership?.role === 'admin',
    callbackUrl: `${app.publicUrl}/api/auth/sso/callback/${siteProviderId(site.slug)}`,
  };
};

export const actions: Actions = {
  telemetry: async (event) => {
    const { app, site, user, membership, manager } = await siteContext(event);
    requireManager(manager);
    const value = String((await event.request.formData()).get('telemetry'));
    return attempt(async () => {
      if (!['on', 'off', 'user'].includes(value)) throw new SiteError('Unknown setting.');
      await setTelemetry(app.ctx, site, user, membership, value as Site['telemetry']);
      return { notice: 'Saved. Members pick it up with their next policy refresh.' };
    });
  },
  sso: async (event) => {
    const { app, site, actor } = await siteContext(event);
    const form = await event.request.formData();
    return attempt(async () => {
      await configureSso(app.ctx, site, actor, {
        issuer: String(form.get('issuer') ?? ''),
        clientId: String(form.get('clientId') ?? ''),
        clientSecret: String(form.get('clientSecret') ?? ''),
        domain: String(form.get('domain') ?? ''),
      });
      return { notice: 'Saved. Add the DNS record below, then verify your domain.' };
    });
  },
  verify: async (event) => {
    const { app, site, actor } = await siteContext(event);
    return attempt(async () => {
      await verifySsoDomain(app.ctx, site, actor);
      return { notice: 'Domain verified. Members can now sign in with single sign-on.' };
    });
  },
  removeSso: async (event) => {
    const { app, site, actor } = await siteContext(event);
    return attempt(async () => {
      await removeSso(app.ctx, site, actor);
      return { notice: 'Single sign-on removed. Members sign in with emailed links.' };
    });
  },
  requireSso: async (event) => {
    const { app, site, actor } = await siteContext(event);
    const required = (await event.request.formData()).get('required') === 'on';
    return attempt(async () => {
      await setSsoRequired(app.ctx, site, actor, required);
      return {
        notice: required
          ? 'Members must now sign in with single sign-on.'
          : 'Members may sign in either way.',
      };
    });
  },
};
