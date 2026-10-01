import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  // The engine's schemas are TypeScript source in the workspace; bundle them.
  ssr: { noExternal: ['@switchback/engine'] },
});
