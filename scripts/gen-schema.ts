/** Regenerate the config JSON Schema shipped with the VS Code extension. `bun run schema` */
import { configJsonSchema } from '@harness/engine';

export const SCHEMA_PATH = new URL('../apps/vscode/schemas/config.schema.json', import.meta.url)
  .pathname;
export const renderSchema = () => `${JSON.stringify(configJsonSchema(), null, 2)}\n`;

if (import.meta.main) {
  await Bun.write(SCHEMA_PATH, renderSchema());
  console.log(`wrote ${SCHEMA_PATH}`);
}
