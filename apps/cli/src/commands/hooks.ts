/**
 * `switchback hooks`: the hooks that run in this workspace, and the project's
 * hooks waiting for trust. `switchback hooks trust`: let them run.
 */
import { hookTrustKey, loadConfig, type SourcedHook, trust } from '@switchback/engine';
import type { CommonFlags } from '../bootstrap.ts';

const describe = (h: Pick<SourcedHook, 'event' | 'matcher'>) =>
  `${h.event}${h.matcher.matcher ? ` [${h.matcher.matcher}]` : ''}: ${h.matcher.hooks.map((c) => c.command).join(' ; ')}`;

export function hooks(sub: string | undefined, flags: CommonFlags): number {
  const { config, untrustedHooks } = loadConfig(flags.cwd, process.env);
  if (sub === 'trust') {
    if (!untrustedHooks.length) {
      process.stdout.write('No project hooks are waiting for trust.\n');
      return 0;
    }
    // Trust the exact definitions as they are now; any later edit needs approval again.
    trust(flags.cwd, Object.fromEntries(untrustedHooks.map((h) => [hookTrustKey(h), h.matcher])));
    for (const h of untrustedHooks) process.stdout.write(`trusted ${describe(h)} (${h.source})\n`);
    return 0;
  }
  if (sub && sub !== 'list') {
    process.stderr.write(`switchback hooks: unknown subcommand "${sub}" (list, trust)\n`);
    return 2;
  }
  const running = Object.entries(config.hooks).flatMap(([event, matchers]) =>
    (matchers ?? []).map(
      (matcher) => `  ${describe({ event: event as SourcedHook['event'], matcher })}`,
    ),
  );
  process.stdout.write(
    running.length ? `Hooks\n${running.join('\n')}\n` : 'No hooks configured.\n',
  );
  if (untrustedHooks.length) {
    process.stdout.write('\nWaiting for trust (they run commands from this repository):\n');
    for (const h of untrustedHooks) process.stdout.write(`  ${describe(h)} (${h.source})\n`);
    process.stdout.write('Review them, then run `switchback hooks trust`.\n');
  }
  return 0;
}
