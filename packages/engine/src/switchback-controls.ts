/**
 * What the models, config, set_config, and set_roles tools see of the engine:
 * the session's models and roles, the configuration in effect, and the two
 * ways to change them.
 */
import { copyFileSync, rmSync } from 'node:fs';
import type { SessionRoles, SessionSetRolesParams } from '@switchback/protocol';
import { priceFor } from '@switchback/providers';
import type { SwitchbackConfig } from './config.ts';
import { replaceConfigText } from './config-write.ts';
import type { LiveSession } from './live-session.ts';
import type { ModelDirectory } from './model-directory.ts';
import type { OrgStatus } from './org/policy.ts';
import type { SwitchbackControls } from './tools/index.ts';

export interface ControlsDeps {
  models: ModelDirectory;
  config(): SwitchbackConfig;
  org(): OrgStatus | undefined;
  roles(s: LiveSession): SessionRoles;
  /** Read and apply the config files again; the top-level keys that changed. Throws if one won't load. */
  reload(): string[];
  setRoles(params: SessionSetRolesParams): SessionRoles & { savedTo?: string };
}

export function switchbackControls(s: LiveSession, deps: ControlsDeps): SwitchbackControls {
  return {
    models: () =>
      deps.models.summaries().flatMap((m) => {
        const info = deps.models.info(m.alias);
        if (!info) return [];
        const price = deps.config().models[m.alias]?.price ?? priceFor(m.ref.model);
        return [
          {
            alias: m.alias,
            provider: m.ref.provider,
            model: m.ref.model,
            tier: m.tier,
            contextWindow: info.contextWindow,
            available: info.available,
            vision: info.vision === true,
            listed: m.listed === true,
            ...(price ? { price } : {}),
          },
        ];
      }),
    roles: () => deps.roles(s),
    config: () => deps.config(),
    org: () => {
      const org = deps.org();
      return org ? { name: org.name, enforcedKeys: org.enforcedKeys } : undefined;
    },
    saveConfig(file, text) {
      const backup = replaceConfigText(file, text);
      try {
        return deps.reload();
      } catch (err) {
        // A file the engine can't load would break the next start too; put it back.
        if (backup) copyFileSync(backup, file);
        else rmSync(file, { force: true });
        throw err;
      }
    },
    setRoles: (params) => deps.setRoles({ ...params, sessionId: s.header.id }),
  };
}
