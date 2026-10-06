/**
 * The site's domain logic: people, sites, seats, roles, single sign-on,
 * devices, policy, usage, and telemetry (ADR 0010, 0012, 0013). Routes stay
 * thin and call these; every rule lives here, where tests exercise it.
 *
 * Credentials are Better Auth's (auth.ts). Changes a site member makes go
 * through `ctx.auth.api` with their own session, so the plugins check their
 * permissions too; this file adds the rules Better Auth doesn't know (only
 * Switchback managers assign operators, a site keeps one, invitations take
 * seats, SSO sessions stay on their site). Switchback managers act on sites they
 * don't belong to, which the plugins don't model, so their changes to
 * memberships are written directly.
 */

export { audit, auditLog, platformAuditLog } from './model/audit.ts';
export type { Actor, Ctx, Membership, Role, Site, User } from './model/core.ts';
export { Email, ROLES, SiteError, SLUG } from './model/core.ts';
export {
  authenticateDevice,
  decideDevice,
  finishDeviceSignIn,
  listDevices,
  OAuthError,
  pendingDevice,
  revokeDevice,
  startDeviceSignIn,
} from './model/devices.ts';
export { listSwitchbackManagers, setSwitchbackManager } from './model/managers.ts';
export type { MemberRow } from './model/members.ts';
export {
  acceptInvitation,
  assignOperator,
  cancelInvitation,
  canManage,
  changeRole,
  invitation,
  invitationsFor,
  invite,
  listMembers,
  membership,
  removeMember,
  sitesOf,
} from './model/members.ts';
export {
  actorFor,
  ensureUser,
  signOut,
  startSignIn,
  startStaffSignIn,
  userByEmail,
  userById,
} from './model/people.ts';
export {
  clientPolicy,
  currentPolicy,
  EditablePolicy,
  policyHistory,
  policyVersion,
  savePolicy,
} from './model/policy.ts';
export { createSite, listSites, seatsUsed, setSeats, siteBySlug } from './model/sites.ts';
export type { SiteSso } from './model/sso.ts';
export {
  configureSso,
  managerSessionProblem,
  removeSso,
  sessionProblem,
  setSsoRequired,
  setTelemetry,
  siteSso,
  verifySsoDomain,
} from './model/sso.ts';
export type { TelemetrySummary, UsageSummary } from './model/usage.ts';
export { addUsage, storeTelemetry, telemetrySummary, usageSummary } from './model/usage.ts';
