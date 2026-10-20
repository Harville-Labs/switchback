/** Setup: whether a hosted provider has credentials, and asking for an API key when it doesn't. */
import { CREDENTIAL_ENV, hasAnthropicCredentials, OPENCODE_KEY_ENV } from '@switchback/providers';
import type { RemoteKind } from '../setup.ts';
import type { SetupFlags } from './flags.ts';
import { asking, type SetupPrompter, say } from './prompter.ts';

export type Env = Record<string, string | undefined>;

/** The variable a provider reads its API key from, for kinds that sign in with one. */
export function keyEnv(kind: RemoteKind): string | undefined {
  switch (kind) {
    case 'anthropic':
    case 'openai':
    case 'deepseek':
    case 'gemini':
    case 'azure-openai':
      return CREDENTIAL_ENV[kind];
    case 'opencode':
      return OPENCODE_KEY_ENV;
    case 'foundry':
      return 'ANTHROPIC_FOUNDRY_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    default:
      return undefined;
  }
}

/** Whether the provider will find a key without one in config. */
export function hasKey(kind: RemoteKind, env: Env): boolean {
  if (kind === 'anthropic') return hasAnthropicCredentials(env);
  if (kind === 'gemini' && env.GOOGLE_API_KEY) return true;
  const name = keyEnv(kind);
  return Boolean(name && env[name]);
}

export function credentialHint(kind: RemoteKind, env: Env): string {
  switch (kind) {
    case 'claude-code':
      return Bun.which('claude')
        ? 'uses your `claude` sign-in'
        : 'install Claude Code and sign in with `claude`';
    case 'codex':
      return Bun.which('codex')
        ? 'uses your `codex` sign-in'
        : 'install Codex and sign in with `codex login`';
    case 'bedrock':
      return 'AWS credentials';
    case 'anthropic-aws':
      return 'AWS credentials and a Claude workspace ID';
    case 'vertex':
      return 'gcloud application-default credentials';
    case 'openai-compatible':
      return 'base URL and API key';
    case 'azure-openai':
      return hasKey(kind, env) ? 'credentials found' : 'an API key or Entra ID, and a deployment';
    case 'anthropic':
      return hasKey(kind, env) ? 'credentials found' : 'needs an API key or `ant auth login`';
    default:
      return hasKey(kind, env) ? 'credentials found' : 'needs an API key';
  }
}

/**
 * An API key to save in config, asked for when the provider has none.
 * Pasted keys go only in the user config, which setup makes readable by the
 * user alone; a project config may be committed, so there setup says which
 * variable to set instead. Undefined: the provider reads its environment.
 */
export async function askApiKey(
  label: string,
  envName: string | undefined,
  flags: SetupFlags,
  ui: SetupPrompter | undefined,
): Promise<string | undefined> {
  const p = asking(ui);
  const later = envName ? `set ${envName}` : 'add the key to providers.<id>.apiKey';
  const warn = () => say(ui, `${label} needs an API key: ${later} before using it.`, 'warning');
  if (!p) return void warn();
  if (flags.scope === 'project') {
    say(ui, "A project config can be committed, so setup doesn't save API keys in it.", 'detail');
    return void warn();
  }
  const key = await p.text(`API key for ${label} (leave empty to ${later} yourself)`, undefined, {
    secret: true,
  });
  if (!key) return void warn();
  say(ui, 'The key goes in your user config, which only you can read.', 'detail');
  return key;
}
