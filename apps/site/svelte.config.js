import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Form actions reject cross-origin posts (SvelteKit's default); stated for the reader.
    csrf: { trustedOrigins: [] },
    csp: {
      mode: 'auto',
      directives: {
        'default-src': ['self'],
        'img-src': ['self', 'data:'],
        'style-src': ['self', 'unsafe-inline'],
        'form-action': ['self'],
        'frame-ancestors': ['none'],
        'base-uri': ['self'],
      },
    },
  },
};
