import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // The org package is TypeScript source in the workspace; bundle it.
  ssr: { noExternal: ['@harville-labs/switchback-org'] },
});
