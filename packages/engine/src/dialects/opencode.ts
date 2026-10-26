/**
 * A config file that declares OpenCode's `$schema`, read as Switchback config:
 * agents, commands, permissions, and the default agent. Providers, models, and
 * MCP servers need choices only setup can make (which alias, where the key
 * lives), so they're left for `switchback init --from opencode`.
 */
import { translateAgents } from '../setup-flow/opencode-agents.ts';
import { type Obj, obj, str } from '../setup-flow/opencode-models.ts';
import { translateCommands } from './opencode-commands.ts';
import { olderFormat, translatePermissions } from './opencode-format.ts';

/** Keys that name models, providers, and servers, which a config file doesn't bring over. */
const SETUP_KEYS = ['provider', 'providers', 'model', 'small_model', 'mcp'];

export function translateOpenCode(raw: Obj): { config: Obj; notes: string[] } {
  const cfg = olderFormat(raw);
  const notes: string[] = [];
  const out: Obj = {};

  // A model reference like `vllm/big#direct` names OpenCode's provider; only a bare alias carries over.
  const aliases: Record<string, string> = {};
  const withoutModels = Object.fromEntries(
    Object.entries(obj(cfg.agent)).map(([name, a]) => {
      const { model, ...rest } = obj(a);
      const ref = str(model);
      if (ref?.includes('/'))
        notes.push(
          `agent ${name}'s model ${ref} names an OpenCode provider; set model to one of your Switchback model aliases`,
        );
      else if (ref) aliases[name] = ref;
      return [name, rest];
    }),
  );
  const agents = translateAgents(withoutModels, () => undefined, [], notes);
  const named = Object.fromEntries(
    Object.entries(agents).map(([name, a]) => [name, { ...a.config }]),
  );
  for (const [name, alias] of Object.entries(aliases))
    named[name] = { ...named[name], model: alias };
  if (Object.keys(named).length) out.agents = named;

  const commands = translateCommands({ ...obj(cfg.commands), ...obj(cfg.command) }, notes);
  if (Object.keys(commands).length) out.commands = commands;

  const permissions = translatePermissions(cfg, notes);
  if (permissions) {
    const { levels, outsideWorkspace, allow, ask, deny } = permissions;
    out.permissions = {
      ...levels,
      ...(outsideWorkspace ? { outsideWorkspace } : {}),
      ...(allow.length ? { allow } : {}),
      ...(ask.length ? { ask } : {}),
      ...(deny.length ? { deny } : {}),
    };
  }
  if (str(cfg.default_agent)) out.defaultAgent = cfg.default_agent;

  const left = SETUP_KEYS.filter((k) => Object.keys(obj(cfg[k])).length || str(cfg[k]));
  if (left.length)
    notes.push(
      `${left.join(', ')}: not read from a config file; \`switchback init --from opencode\` brings OpenCode's providers, models, and MCP servers over`,
    );
  return { config: out, notes };
}
