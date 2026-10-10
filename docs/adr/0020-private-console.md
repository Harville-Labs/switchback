# 0020: The hosted console is private, and Switchback is Apache-2.0 throughout

**Status:** Accepted · 2026-10-10 · Supersedes [0014](0014-open-core-licensing.md)

## Context

[ADR 0014](0014-open-core-licensing.md) made everything here Apache-2.0 except `apps/site`, the hosted console, which stayed proprietary but public so customers could see how it handled their data. Keeping a proprietary app in an open repository has costs. Outside contributors have to be told which directory they can't touch, the repository's license needs an exception in `NOTICE`, and the console's internals (its admin tools, its operations, what it will charge for) are public before they're ready.

The console is a separate kind of app from the rest of this repository. It's a stateful web service with Postgres, Better Auth, and single sign-on, deployed like Harville Labs' other sites. The Switchback code it uses is small: the policy and telemetry formats, the client it signs devices in with, and the install command.

## Decision

- The console moves to Harville Labs' private sites repository (`apps/switchback/console`), beside switchback.sh. Its source is no longer public.
- Everything in this repository is Apache-2.0, with no exceptions. `NOTICE` no longer names one, and every pull request is accepted under Apache-2.0.
- What the console needs from Switchback lives in `packages/org` and is published privately to GitHub Packages as `@harville-labs/switchback-org` with each release. The engine and client re-export it, so there's one copy. The console pins a version.
- Each release attaches `install.sh` and `install.ps1`, and the console serves the latest release's.
- The organization protocol stays public and documented in [organizations.md](../organizations.md), with `packages/engine/src/org/dev-server.ts` as a reference server. Any compatible server works ([ADR 0007](0007-organization-policy.md)). What the hosted service keeps about customers is still documented in [sites.md](../sites.md).
- The rest of ADR 0014 stands: the CLI never checks a license, individuals use Switchback for free, and companies pay for a site.

## Alternatives considered

- **Keep the console here, proprietary and public** (ADR 0014). Changes to the protocol stay in one pull request, but the costs above remain.
- **Publish the whole engine as a private package for the console.** The engine depends on the protocol, providers, and router packages and on every vendor SDK, all of which would have to be published. The console uses four small modules.
- **A private repository of its own.** The console shares its design tokens and deployment with switchback.sh, which are already in the sites repository.

## Consequences

- A change to the organization protocol takes two pull requests. Change and release `packages/org` here first, then bump the package in the console. The console has to keep accepting what released clients send.
- Code in git history before this change, under `apps/site`, stays readable. It keeps the proprietary license it was published under.
- ADRs 0010 to 0013 stay here as the record of the console's design. New decisions about the console's internals are recorded in the sites repository.
- Contributors can no longer see or test the hosted service. The protocol's tests here run against the reference server.
