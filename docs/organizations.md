# Organizations: centrally managed configuration

An organization's policy is pushed to everyone who signs in to Switchback. Companies get this from their site on app.switchback.sh, hosted by Harville Labs ([sites.md](sites.md)); any server implementing the [API below](#server-api) works too. With it, admins can:

- **Provide models:** the company's local model servers (a GPU box, a vLLM cluster) and approved hosted providers, configured for users automatically.
- **Set limits:** per-user daily and monthly caps on remote spend.
- **Restrict providers:** allow only certain provider types, or only the org's own provider definitions.
- **Disable remote entirely:** every model call stays on the org's local models.
- **Enforce settings:** any config value (permissions, routing, subagent limits) that users cannot override.
- **See usage:** Switchback uploads daily usage aggregates, with no prompts or code.

## For users

```sh
switchback login --site acme                             # your company's site on app.switchback.sh
switchback login --server https://switchback.acme.example   # or any compatible server
switchback whoami                                        # organization, policy revision, restrictions
switchback logout
```

After signing in, the org's policy applies to the TUI, VS Code, and `switchback run`. Long-running sessions pick up changes within the policy's refresh interval (default 5 minutes) and show a notice. The last policy is cached, so it keeps applying offline. For CI or managed installs, set `SWITCHBACK_ORG_SERVER` and `SWITCHBACK_ORG_TOKEN` instead of signing in.

## Policy format

```jsonc
{
  "version": "42",                                  // any revision string; shown to users
  "org": { "id": "acme", "name": "Acme Corp" },
  "defaults": {                                     // a config layer below the user's own config
    "providers": {
      "acme-gpu": { "type": "openai-compatible", "baseUrl": "https://gpu.acme.internal/v1" },
      "openai": { "type": "openai", "baseUrl": "https://llm-gateway.acme.internal/openai/v1" }
    },
    "models": {
      "acme-coder": { "provider": "acme-gpu", "model": "acme-coder-32b", "contextWindow": 65536 },
      "remote": { "provider": "openai", "model": "gpt-6-sol", "contextWindow": 1050000 }
    },
    // A user's own local model (alias "local") starts; the company GPU takes
    // prompts too big for it, and everything when the user has no local model.
    "routing": { "start": ["local", "acme-coder"], "escalate": [["remote"]] }
  },
  "enforced": {                                     // a config layer above everything; users can't override
    "permissions": {
      "bash": "ask",
      "deny": ["read(.env)", "read(**/*.pem)", "bash(curl:*)"]  // added to every member's rules
    },
    "routing": { "escalation": { "policy": "ask" } }
  },
  "restrictions": {
    "allowRemote": true,                            // false: remove all remote providers; routing.allowRemote becomes false
    "allowedProviderTypes": ["openai-compatible", "openai"],
    "allowUserProviders": false,                    // only providers defined in this policy
    "allowUserMcpServers": false,                   // only MCP servers defined in this policy
    "allowUserPermissions": false,                  // members can't set their own permissions (their deny rules still apply)
    "allowBypassPermissions": false,                // no bypassPermissions mode
    "allowUserHooks": false,                        // only this policy's hooks run
    "maxDailyUsd": 10,                              // users may set lower budgets, never higher
    "maxMonthlyUsd": 150
  },
  "refreshSeconds": 300
}
```

`defaults` and `enforced` accept anything from [configuration.md](configuration.md). `{env:NAME}` references resolve on the user's machine, so a policy can name the variable holding a key (`"apiKey": "{env:ACME_GPU_KEY}"`) without the key itself.

A role in the policy may name a model only some members define, such as their own `local`. Members without it skip that alias (`switchback whoami` says so) and use the rest of the chain. A misspelled alias in a member's own config is still an error.

### How it's applied

Config layers merge in this order, lowest first:

1. built-in defaults (none)
2. org `defaults`
3. user config (`~/.switchback/config.json`)
4. project config (`.switchback/config.json`), then the project's personal file (`.switchback/config.local.json`)
5. command-line layers
6. org `enforced`

Then `restrictions` run on the result and *remove* anything not allowed: disallowed providers and the models that use them, remote routing when `allowRemote` is false, and MCP servers the org didn't define when `allowUserMcpServers` is false. To block MCP tools entirely, enforce `permissions.mcp: "deny"`. Budgets are capped. `switchback doctor` and `switchback whoami` list exactly what the policy changed.

### Sandbox

Enforce `"bash": { "sandbox": { "mode": "on", "allowUnsandboxed": false } }` to require the OS sandbox for every command and refuse requests to leave it. Members on a platform without it (Windows, or Linux without bubblewrap) can't run commands until they install what `switchback doctor` names.

### Hooks

Hooks in a policy's `defaults` or `enforced` run for every member, alongside their own, and need no trust. With `allowUserHooks: false`, only the policy's hooks run; members' and projects' are ignored, and `switchback whoami` lists what was left out. Enforce an audit hook with `"hooks": { "PostToolUse": [ ... ] }` in `enforced` ([hooks.md](hooks.md)).

### Permissions

**At sign-in**, `switchback login` writes the policy's `permissions` (`defaults` and `enforced` together, rule lists added up) over the `permissions` section of the member's user config, keeping the old file as `.bak`. Members start from the organization's levels and rules instead of the [defaults setup writes](permissions.md#default-rules). A policy without `permissions` leaves members' own alone.

**Whether members may change them** is `restrictions.allowUserPermissions`:

- `true` (the default): what login wrote is the member's to edit, and prompts offer **Always**.
- `false`: the policy's permissions are the only ones that apply, whatever the member's files say. Members' and projects' levels (`permissions.bash`, ...) and allow and ask rules are ignored (`switchback whoami` lists what was left out), and prompts offer no **Always**. Their deny rules still apply, since they only tighten.

Permission rules (`permissions.allow`, `ask`, and `deny`) are the exception to "later layers replace arrays": every layer's rules add up. An organization's deny rules, in `defaults` or `enforced`, join every member's rules as soon as the policy arrives, appear in `/permissions` and `switchback doctor` with the source `organization`, and can't be removed by a member, a project, or an answer at a prompt (deny is checked before anything a session allows). With `allowBypassPermissions: false`, no session can switch to `bypassPermissions`, and a `defaultMode` of `bypassPermissions` becomes `default`. See [permissions.md](permissions.md#rules) for the syntax.

## Server API

Any server implementing these endpoints works. `packages/engine/src/org/dev-server.ts` is a runnable reference implementation (`bun packages/engine/src/org/dev-server.ts policy.json`), and `packages/org` holds the policy format and the client Switchback signs in with. Sign-in is standard OAuth: the device authorization grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) with client ID `switchback`, which Switchback runs with [openid-client](https://github.com/panva/openid-client). Its two endpoints take form posts, as the RFCs require; the others take JSON. Authenticated calls send `Authorization: Bearer <access_token>`.

| Endpoint | Purpose |
|---|---|
| `POST /v1/device/code` | Device authorization endpoint (RFC 8628 section 3.1). Returns `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in`, `interval`. |
| `POST /v1/token` | Token endpoint (RFC 6749). `grant_type=urn:ietf:params:oauth:grant-type:device_code` polls: `400 {"error":"authorization_pending"\|"slow_down"\|"access_denied"\|"expired_token"}` until approved, then a token response. Servers that issue refresh tokens also accept `grant_type=refresh_token`. |
| `GET /v1/policy` | The policy. Send an `ETag`; clients send `If-None-Match` and accept `304`. `401`/`403` for revoked access. |
| `POST /v1/usage` `{entries}` | Optional. Daily aggregates per model: `date`, `tier`, `provider`, `model`, `calls`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`. Reports are increments: add them to what the day already has. Return `404` if unsupported. |
| `POST /v1/telemetry` `{reports}` | Optional. When the member has telemetry on, the [daily reports](telemetry.md) go here instead of to Harville Labs' public endpoint. |

Token response: the RFC 6749 fields (`access_token`, `token_type`, optional `refresh_token` and `expires_in`), plus optional `org: { id, name }` and `user: { email?, name? }` so `switchback login` can say where you signed in (without `org`, it takes the policy's). Clients refresh a token within a minute of its expiry when they have a refresh token. OAuth requests carry an `Origin` header naming the server's own origin, so frameworks that check it on form posts accept them.

Usage reports contain only token counts and costs per model per day, never prompts, file names, or code. Only usage after sign-in is reported.

## Security and enforcement

- Put `privacy.localOnlyPaths` and `privacy.secrets` in `enforced` to guarantee that matching files never reach a remote model on any member's machine, whatever their own settings say ([privacy.md](privacy.md)). An enforced list replaces the user's list rather than adding to it; put the org's paths in `defaults` instead if users should be able to extend it (they can then also shorten it).
- Credentials live in `~/.switchback/auth.json` and the cached policy in the data directory, both readable only by the user (mode 0600).
- If a policy can't be refreshed (server down, token revoked), the last cached policy keeps applying. It's removed only by `switchback logout`.
- **Enforcement happens on the client.** It reliably governs cooperative users and every Switchback client, but someone with control of their own machine can sign out or modify the binary. For hard guarantees:
  - Point hosted providers at an **org gateway** (`baseUrl` in `defaults`/`enforced`) that holds the real API keys and enforces spend server-side. Users then never have provider keys at all.
  - Distribute credentials through device management (`SWITCHBACK_ORG_SERVER`/`SWITCHBACK_ORG_TOKEN`), so signing out isn't a user action.

A system-level managed policy file and a first-party gateway are on the roadmap.
