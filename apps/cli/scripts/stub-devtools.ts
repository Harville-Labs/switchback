import type { BunPlugin } from 'bun';

/**
 * Ink optionally imports react-devtools-core when DEV=true. Bun hoists external
 * imports to the top of a compiled bundle, which would make every run fail, so
 * builds replace the module with an empty stub instead.
 */
export const stubReactDevtools: BunPlugin = {
  name: 'stub-react-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};
