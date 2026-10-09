import { z } from 'zod';
import { DOCS_TOPICS, docsHeadings, docsSection, EMBEDDED_DOCS } from '../docs.ts';
import { defineTool, type ToolContext, ToolError, truncate } from './tool.ts';

/**
 * Reads Switchback's own documentation, as built into this version, so the
 * model can answer questions about Switchback and change its settings the
 * documented way. Needs no permission: the pages are public and nothing
 * leaves the machine.
 */
export const docsTool = defineTool({
  name: 'docs',
  description:
    "Read Switchback's own documentation: configuration keys and files, providers, routing, permissions, hooks, agents, skills, and the clients. Use it before answering a question about Switchback or changing its configuration. Call with no topic for the list of topics; pass `section` to read one heading of a long page.",
  schema: z.object({
    topic: z
      .string()
      .optional()
      .describe('A topic from the list, such as "configuration" or "clients/tui"'),
    section: z
      .string()
      .optional()
      .describe(
        'Part of a heading on that page, such as "routing.budget" or "Files and precedence"',
      ),
  }),
  permission: 'none',
  mutating: false,
  summarize: (i) =>
    i.topic
      ? `read Switchback docs: ${i.topic}${i.section ? ` § ${i.section}` : ''}`
      : 'list Switchback docs',
  async run(input, ctx) {
    if (!input.topic) return topicList();
    const slug = input.topic.trim().replace(/\.md$/, '');
    const page = EMBEDDED_DOCS[slug];
    if (page === undefined) throw new ToolError(`no docs topic "${input.topic}". ${topicList()}`);
    let text = page;
    if (input.section) {
      const section = docsSection(page, input.section);
      if (section === undefined)
        throw new ToolError(
          `no heading in ${slug} matches "${input.section}". Its sections:\n${docsHeadings(page)
            .map((h) => `- ${h}`)
            .join('\n')}`,
        );
      text = section;
    }
    return truncate(slug === 'configuration' ? `${whereConfigLives(ctx)}\n\n${text}` : text);
  },
});

function topicList(): string {
  return `Topics:\n${DOCS_TOPICS.map((t) => `- ${t.slug}: ${t.title}${t.summary ? `: ${t.summary}` : ''}`).join('\n')}`;
}

/**
 * The docs name files generically (`~/.switchback/config.json`); the model
 * needs the real paths, and to know which ones its edit tools can reach.
 */
function whereConfigLives(ctx: ToolContext): string {
  const files = ctx.configFiles;
  if (!files) return '';
  return [
    'On this machine:',
    `- Project config (shared with the team): ${files.project}`,
    `- Your settings for this project only, never committed: ${files.projectLocal}`,
    `- User config (every project): ${files.user}. Editing it asks the user every time, with the diff.`,
    "Edit these files with the edit tool so comments and formatting survive; an edit that would make a config invalid fails with the reason, so fix it and try again. Settings an organization enforces can't be overridden. The running engine read its config when it started, so changes take effect after it restarts: tell the user so.",
  ].join('\n');
}
