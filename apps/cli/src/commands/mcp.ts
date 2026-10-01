/**
 * `switchback mcp`: show MCP servers and their tools' status.
 * `switchback mcp trust [name...]`: allow project-defined servers (from the
 * project's config or Claude Code's .mcp.json) to start in this workspace.
 */
import { formatMcpServers } from '@switchback/client';
import { loadConfig, trustServers } from '@switchback/engine';
import { type CommonFlags, createEngine } from '../bootstrap.ts';

export async function mcp(
  sub: string | undefined,
  names: string[],
  flags: CommonFlags,
): Promise<number> {
  if (sub === 'trust') return trust(names, flags);
  if (sub && sub !== 'list') {
    process.stderr.write(`switchback mcp: unknown subcommand "${sub}" (list, trust)\n`);
    return 2;
  }
  const { engine } = createEngine(flags, 'deny');
  const { servers } = await engine.mcpStatus();
  process.stdout.write(`MCP servers\n${formatMcpServers(servers)}\n`);
  await engine.shutdown();
  return servers.some((s) => s.state === 'failed') ? 1 : 0;
}

function trust(names: string[], flags: CommonFlags): number {
  const { untrustedMcp } = loadConfig(flags.cwd, process.env);
  const pending = names.length ? untrustedMcp.filter((u) => names.includes(u.name)) : untrustedMcp;
  const unknown = names.filter((n) => !untrustedMcp.some((u) => u.name === n));
  if (unknown.length) {
    process.stderr.write(
      `switchback mcp trust: no untrusted project server named ${unknown.join(', ')}\n`,
    );
    return 2;
  }
  if (!pending.length) {
    process.stdout.write('No project MCP servers are waiting for trust.\n');
    return 0;
  }
  // Trust the exact definitions as they are now; any later edit needs approval again.
  trustServers(flags.cwd, Object.fromEntries(pending.map((p) => [p.name, p.definition])));
  for (const p of pending) process.stdout.write(`trusted ${p.name} (${p.source})\n`);
  return 0;
}
