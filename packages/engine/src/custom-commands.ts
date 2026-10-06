/**
 * Custom slash commands: Markdown files in `.switchback/commands/` (the
 * project) or `~/.config/switchback/commands/` (you). The file name is the
 * command; the body is a prompt template. `$ARGUMENTS` is everything after
 * the name, `$1` to `$9` its words. Frontmatter is optional: `description`
 * and `args` (a hint shown in menus). A project's command overrides yours of
 * the same name.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CustomCommandInfo } from '@switchback/protocol';
import { parse as parseYaml } from 'yaml';

export interface CustomCommand extends CustomCommandInfo {
  template: string;
  file: string;
}

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
  return command.template
    .replaceAll('$ARGUMENTS', args)
    .replace(/\$([1-9])/g, (_, n: string) => words[Number(n) - 1] ?? '');
}
