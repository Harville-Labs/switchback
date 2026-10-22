#!/usr/bin/env bun
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { SetupFlags as InitFlags, RemoteKind } from '@switchback/engine';
import {
  EffortLevel,
  PermissionMode,
  RoutePreference,
  SWITCHBACK_BRANCH,
} from '@switchback/protocol';
import { CLI_VERSION } from './bootstrap.ts';
import { HELP } from './help.ts';

const MIN_BUN = [1, 4, 0];

function bunTooOld(): boolean {
  const have = Bun.version.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const h = have[i] ?? 0;
    const m = MIN_BUN[i] ?? 0;
    if (h !== m) return h < m;
  }
  return false;
}

const oneOf = <T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined => {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`--${name} must be one of ${allowed.join(', ')}`);
};

const positive = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number`);
  return n;
};

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  if (bunTooOld()) {
    process.stderr.write(
      `switchback: requires Bun ${MIN_BUN.join('.')} or newer (found ${Bun.version}); run \`bun upgrade\`\n`,
    );
    return 2;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      route: { type: 'string', default: 'auto' },
      agent: { type: 'string' },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      mock: { type: 'boolean', default: false },
      stdio: { type: 'boolean', default: false },
      socket: { type: 'boolean', default: false },
      'no-daemon': { type: 'boolean', default: false },
      continue: { type: 'boolean', short: 'c', default: false },
      resume: { type: 'boolean', short: 'r', default: false },
      session: { type: 'string' },
      'permission-mode': { type: 'string' },
      effort: { type: 'string' },
      output: { type: 'string' },
      allow: { type: 'string', multiple: true },
      deny: { type: 'string', multiple: true },
      'max-steps': { type: 'string' },
      instructions: { type: 'string' },
      scope: { type: 'string' },
      from: { type: 'string' },
      'local-url': { type: 'string', multiple: true },
      'local-model': { type: 'string', multiple: true },
      'context-window': { type: 'string', multiple: true },
      current: { type: 'string', multiple: true },
      // The flag's name before the role was called current; kept for scripts.
      start: { type: 'string', multiple: true },
      escalate: { type: 'string', multiple: true },
      reviewers: { type: 'string' },
      'subagent-model': { type: 'string' },
      'no-local': { type: 'boolean', default: false },
      remote: { type: 'string', multiple: true },
      'remote-model': { type: 'string', multiple: true },
      'remote-context-window': { type: 'string' },
      'remote-url': { type: 'string' },
      'remote-key-env': { type: 'string' },
      region: { type: 'string' },
      profile: { type: 'string' },
      'project-id': { type: 'string' },
      'workspace-id': { type: 'string' },
      resource: { type: 'string' },
      deployment: { type: 'string' },
      'azure-auth': { type: 'string' },
      'opencode-plan': { type: 'string' },
      policy: { type: 'string' },
      'daily-budget': { type: 'string' },
      'monthly-budget': { type: 'string' },
      server: { type: 'string' },
      site: { type: 'string' },
      token: { type: 'string' },
      by: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      tools: { type: 'string' },
      model: { type: 'string' },
      prompt: { type: 'string' },
      budget: { type: 'string' },
      isolation: { type: 'string' },
      period: { type: 'string' },
      to: { type: 'string' },
      telemetry: { type: 'string' },
      review: { type: 'boolean' },
      'no-review': { type: 'boolean' },
      version: { type: 'boolean', short: 'v', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || values.version) {
    process.stdout.write(values.help ? HELP : `${CLI_VERSION}\n`);
    return 0;
  }

  const route = RoutePreference.safeParse(values.route);
  if (!route.success) throw new UsageError('--route must be auto, local, or remote');
  const common = { cwd: resolve(values.cwd ?? process.cwd()), mock: values.mock };
  const permissionMode = oneOf(
    'permission-mode',
    values['permission-mode'],
    PermissionMode.options,
  );
  const effort = oneOf('effort', values.effort, EffortLevel.options);
  const mode = { ...(permissionMode ? { permissionMode } : {}), ...(effort ? { effort } : {}) };
  const scope = oneOf('scope', values.scope, ['user', 'project'] as const);
  // `-r` is the `resume` command, so `switchback -r <id>` and `switchback resume <id>` agree.
  const [command, ...rest] = values.resume ? ['resume', ...positionals] : positionals;
  const daemon = !values['no-daemon'] && !process.env.SWITCHBACK_NO_DAEMON;

  switch (command) {
    case undefined: {
      const { needsSetup } = await import('./bootstrap.ts');
      // First run: Switchback opens on setup, which can be answered "no" throughout.
      const firstRun = !common.mock && process.stdin.isTTY && needsSetup(common.cwd);
      const { tui } = await import('./tui/index.tsx');
      return tui({
        ...common,
        daemon,
        route: route.data,
        ...mode,
        ...(firstRun ? { opening: { setup: {} } } : {}),
        ...(values.agent ? { agent: values.agent } : {}),
        ...(values.session
          ? { resume: values.session }
          : values.continue
            ? { resume: 'latest' }
            : {}),
      });
    }
    case 'resume': {
      if (rest.length > 1) throw new UsageError('resume takes at most one session id');
      const { resumeOptions } = await import('./commands/resume.ts');
      const { tui } = await import('./tui/index.tsx');
      return tui({ ...common, daemon, route: route.data, ...mode, ...resumeOptions(rest[0]) });
    }
    case 'init': {
      const { answersGiven, init } = await import('./commands/init.ts');
      const { HARNESSES, REMOTE_KINDS } = await import('@switchback/engine');
      const from = oneOf('from', values.from, Object.keys(HARNESSES) as (keyof typeof HARNESSES)[]);
      const contextWindows = (values['context-window'] ?? []).map(
        (v) => positive('context-window', v) as number,
      );
      const remoteContextWindow = positive(
        'remote-context-window',
        values['remote-context-window'],
      );
      const remotes = (values.remote ?? []).map(
        (v) => oneOf('remote', v, [...REMOTE_KINDS, 'none'] as const) as RemoteKind | 'none',
      );
      const policy = oneOf('policy', values.policy, ['auto', 'ask', 'off'] as const);
      const dailyBudget = positive('daily-budget', values['daily-budget']);
      const monthlyBudget = positive('monthly-budget', values['monthly-budget']);
      const flags: InitFlags = {
        cwd: common.cwd,
        yes: values.yes,
        noLocal: values['no-local'],
        ...(scope ? { scope } : {}),
        ...(from ? { from } : {}),
        localUrls: values['local-url'] ?? [],
        localModels: values['local-model'] ?? [],
        contextWindows,
        ...(values.current || values.start
          ? { current: [...(values.current ?? []), ...(values.start ?? [])] }
          : {}),
        ...(values.escalate ? { escalate: values.escalate } : {}),
        ...(values.reviewers ? { reviewers: values.reviewers } : {}),
        ...(values['subagent-model'] ? { subagentModel: values['subagent-model'] } : {}),
        remotes,
        remoteModels: values['remote-model'] ?? [],
        ...(remoteContextWindow ? { remoteContextWindow } : {}),
        ...(values['remote-url'] ? { remoteUrl: values['remote-url'] } : {}),
        ...(values['remote-key-env'] ? { remoteKeyEnv: values['remote-key-env'] } : {}),
        ...(values.region ? { region: values.region } : {}),
        ...(values.profile ? { profile: values.profile } : {}),
        ...(values['project-id'] ? { projectId: values['project-id'] } : {}),
        ...(values['workspace-id'] ? { workspaceId: values['workspace-id'] } : {}),
        ...(values.resource ? { resource: values.resource } : {}),
        ...(values.deployment ? { deployment: values.deployment } : {}),
        ...(values['azure-auth']
          ? { azureAuth: oneOf('azure-auth', values['azure-auth'], ['key', 'entra'] as const) }
          : {}),
        ...(values['opencode-plan']
          ? {
              opencodePlan: oneOf('opencode-plan', values['opencode-plan'], ['go', 'zen'] as const),
            }
          : {}),
        ...(policy ? { policy } : {}),
        ...(dailyBudget ? { dailyBudget } : {}),
        ...(monthlyBudget ? { monthlyBudget } : {}),
        ...(values.telemetry
          ? { telemetry: oneOf('telemetry', values.telemetry, ['on', 'off'] as const) === 'on' }
          : {}),
      };
      if (values.yes || !process.stdin.isTTY || answersGiven(flags)) return init(flags);
      // Plain `switchback init` is `/init`: Switchback opens on setup.
      const { tui } = await import('./tui/index.tsx');
      return tui({
        ...common,
        daemon,
        route: route.data,
        opening: { setup: scope ? { scope } : {} },
      });
    }
    case 'config': {
      const { config } = await import('./commands/config.ts');
      return config(rest[0], { cwd: common.cwd, ...(scope ? { scope } : {}) });
    }
    case 'run': {
      const prompt = rest.join(' ').trim() || (process.stdin.isTTY ? '' : await Bun.stdin.text());
      if (!prompt.trim()) throw new UsageError('run needs a prompt');
      const { run } = await import('./commands/run.ts');
      const output = oneOf('output', values.output, ['text', 'json', 'events'] as const) ?? 'text';
      const maxSteps = positive('max-steps', values['max-steps']);
      const allow = values.allow ?? [];
      const deny = values.deny ?? [];
      const layers = [
        ...(allow.length || deny.length ? [{ permissions: { allow, deny } }] : []),
        ...(maxSteps ? [{ maxStepsPerTurn: maxSteps }] : []),
      ];
      return run({
        ...common,
        ...(layers.length ? { layers } : {}),
        prompt,
        route: route.data,
        yes: values.yes,
        output,
        ...mode,
        ...(values.instructions ? { instructions: values.instructions } : {}),
        ...(values.session
          ? { resume: values.session }
          : values.continue
            ? { resume: 'latest' }
            : {}),
        ...(values.review ? { review: true } : values['no-review'] ? { review: false } : {}),
        ...(values.agent ? { agent: values.agent } : {}),
      });
    }
    case 'serve': {
      if (values.stdio === values.socket)
        throw new UsageError(
          'serve needs exactly one of --stdio or --socket (see docs/protocol.md)',
        );
      if (values.socket && values.mock)
        throw new UsageError('a shared daemon never runs mock providers; use --stdio with --mock');
      const { serve } = await import('./commands/serve.ts');
      return serve({ ...common, socket: values.socket });
    }
    case 'acp': {
      const { acpServer } = await import('./commands/acp.ts');
      return acpServer({
        ...common,
        daemon,
      });
    }
    case 'agents': {
      const { agents } = await import('./commands/agents.ts');
      const budget = positive('budget', values.budget);
      const isolation = oneOf('isolation', values.isolation, ['worktree', 'none'] as const);
      return agents(rest[0], {
        ...common,
        yes: values.yes,
        ...(scope ? { scope } : {}),
        ...(values.name ? { name: values.name } : {}),
        ...(values.description ? { description: values.description } : {}),
        ...(values.tools !== undefined ? { tools: values.tools } : {}),
        ...(values.model ? { model: values.model } : {}),
        ...(values.prompt ? { prompt: values.prompt } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(isolation ? { isolation: isolation === 'worktree' } : {}),
      });
    }
    case 'mcp': {
      const { mcp } = await import('./commands/mcp.ts');
      return mcp(rest[0], rest.slice(1), common);
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.ts');
      return doctor(common);
    }
    case 'login': {
      const { login } = await import('./commands/org.ts');
      return login({
        cwd: common.cwd,
        ...(values.server ? { server: values.server } : {}),
        ...(values.site ? { site: values.site } : {}),
        ...(values.token ? { token: values.token } : {}),
      });
    }
    case 'logout': {
      const { logout } = await import('./commands/org.ts');
      return logout();
    }
    case 'whoami': {
      const { whoami } = await import('./commands/org.ts');
      return whoami(common.cwd);
    }
    case 'self-update':
    case 'selfupdate':
    case 'upgrade':
    case 'update': {
      if (rest.length > 1) throw new UsageError('self-update takes at most one version');
      const { selfUpdate } = await import('./commands/self-update.ts');
      return selfUpdate({ ...(rest[0] ? { version: rest[0] } : {}), check: values.check });
    }
    case 'telemetry': {
      const { telemetry } = await import('./commands/telemetry.ts');
      return telemetry(rest[0], common);
    }
    case 'sandbox': {
      const { sandbox } = await import('./commands/sandbox.ts');
      return sandbox(rest[0]);
    }
    case 'hooks': {
      const { hooks } = await import('./commands/hooks.ts');
      return hooks(rest[0], common);
    }
    case 'worktrees': {
      const branch = rest[0];
      if (branch && !SWITCHBACK_BRANCH.test(branch))
        throw new UsageError(
          `"${branch}" isn't a branch Switchback made for a subagent; \`switchback worktrees\` lists them`,
        );
      const { worktrees } = await import('./commands/worktrees.ts');
      return worktrees({ ...common, json: values.json, ...(branch ? { branch } : {}) });
    }
    case 'sessions': {
      const { sessions } = await import('./commands/sessions.ts');
      return sessions({ ...common, json: values.json });
    }
    case 'usage': {
      const { usage } = await import('./commands/usage.ts');
      return usage({
        ...common,
        json: values.json,
        ...(values.by ? { by: values.by } : {}),
        ...(values.period ? { period: values.period } : {}),
        ...(values.from ? { from: values.from } : {}),
        ...(values.to ? { to: values.to } : {}),
      });
    }
    default:
      process.stderr.write(`switchback: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

/** With telemetry on, keep a scrubbed record of the crash for the next report. */
async function recordCrashIfEnabled(err: unknown): Promise<void> {
  try {
    const { loadConfig, switchbackPaths, recordCrash } = await import('@switchback/engine');
    if (loadConfig(process.cwd(), process.env).config.telemetry.enabled)
      recordCrash(switchbackPaths().dataDir, err, new Date());
  } catch {
    // Reporting a crash must never cause another one.
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  async (err) => {
    if (
      err instanceof UsageError ||
      (err as { code?: string })?.code?.startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`switchback: ${(err as Error).message}\n`);
      process.exit(2);
    }
    process.stderr.write(`switchback: ${(err as Error).stack ?? err}\n`);
    await recordCrashIfEnabled(err);
    process.exit(1);
  },
);
