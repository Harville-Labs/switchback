/**
 * What the user and project add in files: custom commands and skills. Both
 * are rescanned on use (a few small files), so new ones appear without a
 * restart; a file that can't be used is reported once.
 */
import type { CustomCommandInfo } from '@switchback/protocol';
import type { CommandConfig } from './config-schema.ts';
import {
  type CommandDir,
  type CustomCommand,
  configCommands,
  expandCommand,
  loadCustomCommands,
} from './custom-commands.ts';
import { loadSkills, type Skill, type SkillDir } from './skills.ts';

export interface LibraryDirs {
  commands: CommandDir[];
  skills: SkillDir[];
}

export class Library {
  private reported = new Set<string>();

  constructor(
    private readonly dirs: LibraryDirs,
    private readonly warn: (message: string) => void,
    /** The config's `commands`, read each time so a reload applies. */
    private readonly config: () => Record<string, CommandConfig> = () => ({}),
  ) {}

  commands(): Map<string, CustomCommand> {
    const { commands, errors } = loadCustomCommands(this.dirs.commands);
    const fromConfig = configCommands(this.config());
    this.report('custom command skipped', [...errors, ...fromConfig.errors]);
    for (const [name, command] of fromConfig.commands) commands.set(name, command);
    return commands;
  }

  listCommands(): CustomCommandInfo[] {
    return [...this.commands().values()].map(({ name, description, args, source }) => ({
      name,
      description,
      ...(args ? { args } : {}),
      source,
    }));
  }

  /** A prompt with a custom command (`/name args`) expanded; other text as it was. */
  expand(text: string): string {
    if (!text.trimStart().startsWith('/')) return text;
    return expandCommand(text, this.commands()) ?? text;
  }

  skills(): Map<string, Skill> {
    const { skills, errors } = loadSkills(this.dirs.skills);
    this.report('skill skipped', errors);
    return skills;
  }

  private report(what: string, errors: string[]): void {
    for (const e of errors) {
      if (this.reported.has(e)) continue;
      this.reported.add(e);
      this.warn(`${what}: ${e}`);
    }
  }
}
