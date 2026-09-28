import { defineConfig } from 'drizzle-kit';

// `bun run db:generate` turns schema changes into a new SQL migration in ./drizzle.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/server/schema.ts',
  out: './drizzle',
});
