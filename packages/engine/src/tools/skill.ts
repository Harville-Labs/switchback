import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { skillFiles, splitSkill } from '../skills.ts';
import { defineTool, resolveInWorkspace, ToolError, truncate } from './tool.ts';

/**
 * Loads a skill listed in the system prompt: its instructions, and the other
 * files in its folder, which it can then load by name. Reading the user's own
 * skills needs no permission; paths can't leave the skill's folder.
 */
export const skillTool = defineTool({
  name: 'skill',
  description:
    'Load a skill from the Skills section of your instructions before doing the kind of work it covers. Returns its instructions and lists its other files; pass `file` to read one of them.',
  schema: z.object({
    name: z.string().describe('The skill, as listed'),
    file: z.string().optional().describe("One of the skill's other files, relative to its folder"),
  }),
  permission: 'none',
  mutating: false,
  summarize: (i) => (i.file ? `read ${i.file} from skill ${i.name}` : `load skill ${i.name}`),
  async run(input, ctx) {
    const skill = ctx.skills?.().get(input.name);
    if (!skill) throw new ToolError(`no skill named "${input.name}"`);
    if (input.file) {
      const file = resolveInWorkspace(skill.dir, input.file);
      const text = await readFile(file, 'utf8').catch(() => {
        throw new ToolError(`skill ${skill.name} has no file ${input.file}`);
      });
      return truncate(text);
    }
    const { body } = splitSkill(await readFile(join(skill.dir, 'SKILL.md'), 'utf8'));
    const files = skillFiles(skill);
    const listing = files.length
      ? `\n\nFiles in this skill:\n${files.map((f) => `- ${f}`).join('\n')}`
      : '';
    return truncate(body + listing);
  },
});
