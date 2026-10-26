/**
 * OpenCode's `command` (V2: `commands`) entries as Switchback `commands`
 * config. Shared by setup and by config files that declare OpenCode's `$schema`.
 */
import { type Obj, obj, str } from '../setup-flow/opencode-models.ts';

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** `skipped` collects what didn't come over, each with its reason. */
export function translateCommands(commands: Obj, skipped: string[]): Record<string, Obj> {
  const out: Record<string, Obj> = {};
  let models = 0;
  for (const [name, raw] of Object.entries(commands)) {
    const c = obj(raw);
    const template = str(c.template);
    if (!NAME.test(name)) {
      skipped.push(
        `command ${name}: Switchback command names are lowercase letters, digits, and dashes`,
      );
      continue;
    }
    if (!template || template.startsWith('{file:')) {
      skipped.push(
        template
          ? `command ${name}'s template is a file reference; copy the file's text into its template`
          : `command ${name}: it has no template`,
      );
      continue;
    }
    if (/!`[^`]+`/.test(template))
      skipped.push(
        `command ${name} runs shell commands inside its template (!\`...\`), which Switchback doesn't do; the text is sent as written`,
      );
    if (c.model !== undefined) models++;
    const description = str(c.description);
    out[name] = {
      template,
      ...(description ? { description } : {}),
      ...(str(c.agent) ? { agent: c.agent } : {}),
      ...(typeof c.subagent === 'boolean' ? { subagent: c.subagent } : {}),
    };
  }
  if (models)
    skipped.push(
      `the model set on ${models} command${models === 1 ? '' : 's'}: Switchback commands run on the session's model; pin a model on an agent instead`,
    );
  return out;
}
