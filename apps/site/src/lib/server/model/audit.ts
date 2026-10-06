/** The audit log: who changed what, on which site. */
import { desc, eq, isNull } from 'drizzle-orm';
import * as t from '../schema.ts';
import type { Ctx, Site, User } from './core.ts';

export async function audit(
  ctx: Ctx,
  siteId: string | null,
  actor: User | undefined,
  action: string,
  detail?: string,
): Promise<void> {
  await ctx.db.insert(t.auditLog).values({
    id: crypto.randomUUID(),
    siteId,
    actorId: actor?.id ?? null,
    action,
    detail: detail ?? null,
    at: ctx.now(),
  });
}

/** Changes made outside any one site, such as granting Switchback manager access. */
export async function platformAuditLog(ctx: Ctx, limit = 50) {
  return ctx.db
    .select({
      at: t.auditLog.at,
      actor: t.user.email,
      action: t.auditLog.action,
      detail: t.auditLog.detail,
    })
    .from(t.auditLog)
    .leftJoin(t.user, eq(t.user.id, t.auditLog.actorId))
    .where(isNull(t.auditLog.siteId))
    .orderBy(desc(t.auditLog.at))
    .limit(limit);
}

export async function auditLog(ctx: Ctx, site: Site, limit = 200) {
  return ctx.db
    .select({
      at: t.auditLog.at,
      actor: t.user.email,
      action: t.auditLog.action,
      detail: t.auditLog.detail,
    })
    .from(t.auditLog)
    .leftJoin(t.user, eq(t.user.id, t.auditLog.actorId))
    .where(eq(t.auditLog.siteId, site.id))
    .orderBy(desc(t.auditLog.at))
    .limit(limit);
}
