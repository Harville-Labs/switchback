/**
 * Skills, in the open Agent Skills format: a folder with a `SKILL.md` whose
 * frontmatter has a `name` and a `description`, and whose body (with any
 * other files in the folder) is what the model reads when it needs it. They
 * live in `.switchback/skills/` (the project) or
 * `~/.switchback/skills/` (you); a project's skill overrides yours.
 *
 * Only names and descriptions go in the system prompt; the `skill` tool loads
 * the rest on demand, so unused skills cost a line each.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  source: 'user' | 'project';
}

export interface SkillDir {
  dir: string;
  source: Skill['source'];
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function loadSkills(dirs: SkillDir[]): { skills: Map<string, Skill>; errors: string[] } {
  const skills = new Map<string, Skill>();
  const errors: string[] = [];
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const folder = join(dir, entry);
      const file = join(folder, 'SKILL.md');
      if (!existsSync(file)) continue;
      try {
        const { meta } = splitSkill(readFileSync(file, 'utf8'));
        const name = typeof meta.name === 'string' ? meta.name : entry;
        if (!NAME.test(name))
          throw new Error(`"${name}" isn't a valid skill name (lowercase, digits, dashes)`);
        if (typeof meta.description !== 'string' || !meta.description.trim())
          throw new Error(
            'SKILL.md needs a description saying what the skill is for and when to use it',
          );
        skills.set(name, { name, description: meta.description.trim(), dir: folder, source });
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`);
      }
    }
  }
  return { skills, errors };
}

/** SKILL.md's frontmatter and body. */
export function splitSkill(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter (name, description)');
  return {
    meta: (parseYaml(m[1] ?? '') ?? {}) as Record<string, unknown>,
    body: (m[2] ?? '').trim(),
  };
}

/** The other files in a skill's folder, relative to it, for the model to load by name. */
export function skillFiles(skill: Skill, limit = 100): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (out.length >= limit) return;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path !== join(skill.dir, 'SKILL.md'))
        out.push(relative(skill.dir, path).split(sep).join('/'));
    }
  };
  walk(skill.dir);
  return out;
}

/** The skills section of a system prompt, or undefined when there are none. */
export function skillsSection(skills: Iterable<Skill>): string | undefined {
  const lines = [...skills].map((s) => `- ${s.name}: ${s.description}`);
  if (!lines.length) return undefined;
  return `# Skills\nInstructions for particular kinds of work. When a task matches one, load it with the skill tool before starting.\n${lines.join('\n')}`;
}
