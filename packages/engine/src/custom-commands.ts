/**
 * Custom slash commands: Markdown files in `.switchback/commands/` (the
 * project) or `~/.switchback/commands/` (you). The file name is the
 * command; the body is a prompt template. `$ARGUMENTS` is everything after
 * the name, `$1` to `$9` its words. Frontmatter is optional: `description`
 * and `args` (a hint shown in menus). A project's command overrides yours of
 * the same name. `subagent: true` (with an optional `agent`) hands the prompt to
 * a subagent. The config's `commands` entries define the same thing and
 * win over files.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CustomCommandInfo } from '@switchback/protocol';
import { parse as parseYaml } from 'yaml';
import type { CommandConfig } from './config-schema.ts';

export interface CustomCommand extends CustomCommandInfo {
  template: string;
  file: string;
  /** Hand the prompt to this subagent (`agent`, default `general`) through the task tool. */
  subagent?: boolean;
  agent?: string;
}

/** The prompt a command makes: its template with the arguments filled in. */
const delegated = (command: CustomCommand, prompt: string) =>
  command.subagent
    ? `Use the task tool to hand the following to the ${command.agent ?? 'general'} subagent, then tell me what it found or did.\n\n${prompt}`
    : prompt;

export interface CommandDir {
  dir: string;
  source: CustomCommandInfo['source'];
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Every command in the directories (later ones win), and why any file was skipped. */
export function loadCustomCommands(dirs: CommandDir[]): {
  commands: Map<string, CustomCommand>;
  errors: string[];
} {
  const commands = new Map<string, CustomCommand>();
  const errors: string[] = [];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const file = join(dir, entry);
      const name = basename(entry, '.md');
      if (!NAME.test(name)) {
        errors.push(`${file}: command names are lowercase letters, digits, and dashes`);
        continue;
      }
      try {
        commands.set(name, parseCommand(readFileSync(file, 'utf8'), name, source, file));
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }
  }
  return { commands, errors };
}

/** Commands defined in config, which win over files of the same name; a bad name is reported and skipped. */
export function configCommands(entries: Record<string, CommandConfig>): {
  commands: Map<string, CustomCommand>;
  errors: string[];
} {
  const commands = new Map<string, CustomCommand>();
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(entries)) {
    if (!NAME.test(name)) {
      errors.push(
        `config commands.${name}: command names are lowercase letters, digits, and dashes`,
      );
      continue;
    }
    const template = entry.template.trim();
    if (!template) {
      errors.push(`config commands.${name}: the command has no prompt`);
      continue;
    }
    commands.set(name, {
      name,
      description: entry.description ?? (template.split('\n')[0] ?? '').slice(0, 80),
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.subagent !== undefined ? { subagent: entry.subagent } : {}),
      ...(entry.agent ? { agent: entry.agent } : {}),
      source: 'config',
      template,
      file: 'config',
    });
  }
  return { commands, errors };
}

function parseCommand(
  text: string,
  name: string,
  source: CustomCommandInfo['source'],
  file: string,
): CustomCommand {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta = m ? ((parseYaml(m[1] ?? '') ?? {}) as Record<string, unknown>) : {};
  const template = (m ? (m[2] ?? '') : text).trim();
  if (!template) throw new Error('the command has no prompt');
  const description =
    typeof meta.description === 'string'
      ? meta.description
      : (template.split('\n')[0] ?? '').slice(0, 80);
  return {
    name,
    description,
    ...(typeof meta.args === 'string' ? { args: meta.args } : {}),
    ...(typeof meta.subagent === 'boolean' ? { subagent: meta.subagent } : {}),
    ...(typeof meta.agent === 'string' ? { agent: meta.agent } : {}),
    source,
    template,
    file,
  };
}

/** `/name args` as the prompt its command makes, or undefined if it isn't one. */
export function expandCommand(
  text: string,
  commands: Map<string, CustomCommand>,
): string | undefined {
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = m?.[1] ? commands.get(m[1]) : undefined;
  if (!command) return undefined;
  const args = (m?.[2] ?? '').trim();
  const words = args ? args.split(/\s+/) : [];
  return delegated(
    command,
    command.template
      .replaceAll('$ARGUMENTS', args)
      .replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? ''),
  );
}
