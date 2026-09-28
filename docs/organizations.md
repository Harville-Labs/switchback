# Organizations: centrally managed configuration

An organization can run a config server that pushes policy to everyone who signs in to Harness. With it, admins can:

- **Provide models:** the company's local model servers (a GPU box, a vLLM cluster) and approved hosted providers, configured for users automatically.
- **Set limits:** per-user daily and monthly caps on remote spend.
- **Restrict providers:** allow only certain provider types, or only the org's own provider definitions.
- **Disable remote entirely:** every model call stays on the org's local models.
- **Enforce settings:** any config value (permissions, routing, subagent limits) that users cannot override.
- **See usage:** Harness uploads daily usage aggregates, with no prompts or code.

## For users

```sh
harness login --server https://harness.acme.example   # opens the browser to confirm a code
harness whoami                                        # organization, policy revision, restrictions
harness logout
```

After signing in, the org's policy applies to the TUI, VS Code, and `harness run`. Long-running sessions pick up changes within the policy's refresh interval (default 5 minutes) and show a notice. The last policy is cached, so it keeps applying offline. For CI or managed installs, set `HARNESS_ORG_SERVER` and `HARNESS_ORG_TOKEN` instead of signing in.

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
    // A user's own local model (alias "local") stays first; the company GPU takes
    // prompts too big for it, and everything when the user has no local model.
    "routing": { "local": ["local", "acme-coder"] }
  },
  "enforced": {                                     // a config layer above everything; users can't override
    "permissions": { "bash": "ask" },
    "routing": { "escalation": { "policy": "ask" } }
  },
  "restrictions": {
    "allowRemote": true,                            // false: remove all remote providers, route local-only
    "allowedProviderTypes": ["openai-compatible", "openai"],
    "allowUserProviders": false,                    // only providers defined in this policy
    "allowUserMcpServers": false,                   // only MCP servers defined in this policy
    "maxDailyUsd": 10,                              // users may set lower budgets, never higher
    "maxMonthlyUsd": 150
  },
  "refreshSeconds": 300
}
```

`defaults` and `enforced` accept anything from [configuration.md](configuration.md). `{env:NAME}` references resolve on the user's machine.

### How it's applied

Config layers merge in this order, lowest first:

1. built-in defaults (none)
2. org `defaults`
3. user config (`~/.config/harness/config.json`)
4. project config (`.harness/config.json`)
5. command-line layers
6. org `enforced`

Then `restrictions` run on the result and *remove* anything not allowed: disallowed providers and the models that use them, remote routing when `allowRemote` is false, and MCP servers the org didn't define when `allowUserMcpServers` is false. To block MCP tools entirely, enforce `permissions.mcp: "deny"`. Budgets are capped. `harness doctor` and `harness whoami` list exactly what the policy changed.

## Server API

Any server implementing these endpoints works. `packages/engine/src/org/dev-server.ts` is a runnable reference implementation (`bun packages/engine/src/org/dev-server.ts policy.json`). All bodies are JSON; authenticated calls send `Authorization: Bearer <access_token>`.

| Endpoint | Purpose |
|---|---|
| `POST /v1/device/code` | Start sign-in. Returns `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in`, `interval` (RFC 8628 shape). |
| `POST /v1/device/token` `{device_code}` | Poll. `400 {"error":"authorization_pending"\|"slow_down"\|"access_denied"\|"expired_token"}` until approved, then `200` token response. |
| `POST /v1/token/refresh` `{refresh_token}` | New token response; `401` when the session is over. |
| `GET /v1/policy` | The policy. Send an `ETag`; clients send `If-None-Match` and accept `304`. `401`/`403` for revoked access. |
| `POST /v1/usage` `{entries}` | Optional. Daily aggregates per model: `date`, `tier`, `provider`, `model`, `calls`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`. Return `404` if unsupported. |

Token response: `{ access_token, refresh_token?, expires_in?, org: { id, name }, user: { email?, name? } }`. Clients refresh the token when it's within a minute of expiry.

Usage reports contain only token counts and costs per model per day, never prompts, file names, or code. Only usage after sign-in is reported.

## Security and enforcement

- Put `privacy.localOnlyPaths` and `privacy.secrets` in `enforced` to guarantee that matching files never reach a remote model on any member's machine, whatever their own settings say ([privacy.md](privacy.md)). An enforced list replaces the user's list rather than adding to it; put the org's paths in `defaults` instead if users should be able to extend it (they can then also shorten it).
- Credentials live in `~/.config/harness/auth.json` and the cached policy in the data directory, both readable only by the user (mode 0600).
- If a policy can't be refreshed (server down, token revoked), the last cached policy keeps applying. It's removed only by `harness logout`.
- **Enforcement happens on the client.** It reliably governs cooperative users and every Harness client, but someone with control of their own machine can sign out or modify the binary. For hard guarantees:
  - Point hosted providers at an **org gateway** (`baseUrl` in `defaults`/`enforced`) that holds the real API keys and enforces spend server-side. Users then never have provider keys at all.
  - Distribute credentials through device management (`HARNESS_ORG_SERVER`/`HARNESS_ORG_TOKEN`), so signing out isn't a user action.

A system-level managed policy file and a first-party gateway are on the roadmap.
