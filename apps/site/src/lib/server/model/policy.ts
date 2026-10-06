/** Policy: versioned, validated organization policy and what clients receive. */
import { OrgPolicy } from '@switchback/engine/org/schema';
import { and, desc, eq } from 'drizzle-orm';
import * as t from '../schema.ts';
import { audit } from './audit.ts';
import type { Ctx, Membership, Site, User } from './core.ts';
import { assertManager } from './members.ts';

/**
 * What admins edit: the policy without the parts the site fills in (`org`,
 * `version`). Validated with the same schema clients use.
 */
export const EditablePolicy = OrgPolicy.omit({ version: true, org: true });

export async function currentPolicy(
  ctx: Ctx,
  site: Site,
): Promise<{ version: number; body: Record<string, unknown> }> {
  const [r] = await ctx.db
    .select()
    .from(t.policies)
    .where(eq(t.policies.siteId, site.id))
    .orderBy(desc(t.policies.version))
    .limit(1);
  return r ? { version: r.version, body: r.body } : { version: 0, body: {} };
}

export async function policyHistory(ctx: Ctx, site: Site) {
  const rows = await ctx.db
    .select({
      version: t.policies.version,
      note: t.policies.note,
      createdAt: t.policies.createdAt,
      by: t.user.email,
    })
    .from(t.policies)
    .leftJoin(t.user, eq(t.user.id, t.policies.createdBy))
    .where(eq(t.policies.siteId, site.id))
    .orderBy(desc(t.policies.version));
  return rows;
}

export async function policyVersion(ctx: Ctx, site: Site, version: number) {
  const [r] = await ctx.db
    .select({ body: t.policies.body })
    .from(t.policies)
    .where(and(eq(t.policies.siteId, site.id), eq(t.policies.version, version)));
  return r?.body;
}

/** Save a new policy version, or return why it's invalid. */
export async function savePolicy(
  ctx: Ctx,
  site: Site,
  actor: User,
  actorMembership: Membership | undefined,
  body: unknown,
  note?: string,
): Promise<{ version: number } | { problems: string[] }> {
  assertManager(actorMembership, actor);
  const parsed = EditablePolicy.safeParse(body);
  if (!parsed.success)
    return {
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(policy)'}: ${i.message}`),
    };
  const { version } = await currentPolicy(ctx, site);
  const next = version + 1;
  await ctx.db.insert(t.policies).values({
    siteId: site.id,
    version: next,
    body: body as Record<string, unknown>,
    note: note?.trim() || null,
    createdBy: actor.id,
    createdAt: ctx.now(),
  });
  await audit(ctx, site.id, actor, 'policy.saved', `version ${next}${note ? `: ${note}` : ''}`);
  return { version: next };
}

/** The policy clients receive: the admins' policy plus the site's own settings. */
export async function clientPolicy(ctx: Ctx, site: Site): Promise<Record<string, unknown>> {
  const { version, body } = await currentPolicy(ctx, site);
  const enforced = { ...((body.enforced as Record<string, unknown> | undefined) ?? {}) };
  if (site.telemetry !== 'user') {
    const tel = (enforced.telemetry as Record<string, unknown> | undefined) ?? {};
    enforced.telemetry = { ...tel, enabled: site.telemetry === 'on' };
  }
  // The version covers site settings too, so clients see a telemetry change as an update.
  return {
    ...body,
    enforced,
    version: `${version}.${site.telemetry}`,
    org: { id: site.slug, name: site.name },
  };
}
