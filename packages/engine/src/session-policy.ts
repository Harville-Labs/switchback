/**
 * What decides where a session's calls may go: its roles and router, whether
 * a remote model may be called now, and which paths are private. The
 * collaborators borrow these through `EngineHost`.
 */
import type { SessionRoles, SessionSetRolesParams } from '@switchback/protocol';
import { budgetReached, Router } from '@switchback/router';
import type { SwitchbackConfig } from './config.ts';
import type { UsageLedger } from './ledger.ts';
import type { LiveSession } from './live-session.ts';
import type { ModelDirectory } from './model-directory.ts';
import type { OrgStatus } from './org/policy.ts';
import { type PrivatePathMatcher, privatePathMatcher } from './privacy.ts';
import type { SessionRegistry } from './session-registry.ts';
import { changeRoles, effectiveRoles, rolesLayer } from './session-roles.ts';
import { writeConfigLayer } from './setup.ts';

export interface SessionPolicyDeps {
  config(): SwitchbackConfig;
  org(): OrgStatus | undefined;
  models: ModelDirectory;
  ledger: UsageLedger;
  sessions: SessionRegistry;
}

export class SessionPolicy {
  private router: Router;
  private privateMatcher: { key: string; matches: PrivatePathMatcher | undefined } | undefined;

  constructor(private readonly deps: SessionPolicyDeps) {
    this.router = this.newRouter(deps.config().routing);
  }

  /** The configuration changed: routing follows it. */
  reconfigure(config: SwitchbackConfig): void {
    this.router = this.newRouter(config.routing);
  }

  rolesOf(s: LiveSession): SessionRoles {
    return effectiveRoles(this.deps.config(), this.deps.sessions.top(s).roles);
  }

  /**
   * Change a session's roles (ADR 0015). With `save`, write them to `userConfigFile`
   * as the default for new sessions. Keys an organization enforces can't be changed.
   */
  setRoles(
    s: LiveSession,
    params: SessionSetRolesParams,
    userConfigFile: string,
  ): SessionRoles & { savedTo?: string } {
    const top = this.deps.sessions.top(s);
    top.roles = changeRoles(top.roles, params, this.deps.config(), this.deps.org());
    const result = this.rolesOf(top);
    if (!params.save) return result;
    // Checked above against the merged config; the models may live in another file.
    writeConfigLayer(userConfigFile, rolesLayer(result), { references: false });
    return { ...result, savedTo: userConfigFile };
  }

  /** The router for a session: the config's, or one with the session's own roles. */
  routerFor(s: LiveSession): Router {
    const own = this.deps.sessions.top(s).roles;
    if (!own?.start && !own?.escalate) return this.router;
    const roles = this.rolesOf(s);
    return this.newRouter({
      ...this.deps.config().routing,
      start: roles.start,
      escalate: roles.escalate,
    });
  }

  /**
   * Why a remote model may not be called for this session now, or undefined
   * when it may: an organization's switch, `routing.allowRemote`, private
   * content, or a spent budget. Remote calls made outside the router (review,
   * summaries, external runtimes) all check this.
   */
  remoteBlocked(s?: LiveSession): string | undefined {
    const config = this.deps.config();
    const org = this.deps.org();
    if (org?.remoteDisabled) return `remote models are disabled by ${org.name} policy`;
    if (!config.routing.allowRemote) return 'remote models are turned off (routing.allowRemote)';
    if (s?.private)
      return `this session holds private content (${s.private}), which never leaves this machine`;
    return budgetReached(config.routing.budget, this.deps.ledger.spend());
  }

  /** Matcher for `privacy.localOnlyPaths`, rebuilt when the patterns change. */
  privatePaths(): PrivatePathMatcher | undefined {
    const patterns = this.deps.config().privacy.localOnlyPaths;
    const key = JSON.stringify(patterns);
    if (this.privateMatcher?.key !== key)
      this.privateMatcher = { key, matches: privatePathMatcher(patterns) };
    return this.privateMatcher.matches;
  }

  private newRouter(routing: SwitchbackConfig['routing']): Router {
    return new Router(routing, (alias) => this.deps.models.info(alias));
  }
}
