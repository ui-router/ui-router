import { defineConfig } from 'vitest/config';
import sourceAliases from '../../../tools/source-aliases.cjs';

const source = sourceAliases.vitestConfigFor('@uirouter/react');

export default defineConfig({
  plugins: source.plugins,
  resolve: {
    alias: [
      ...source.aliases,
      // Keep package JSX and the hoisted Testing Library renderer on one React instance.
      { find: /^react$/, replacement: `${source.repositoryRoot}/node_modules/react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${source.repositoryRoot}/node_modules/react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${source.repositoryRoot}/node_modules/react/jsx-dev-runtime.js` },
    ],
  },
  server: { fs: { allow: [source.repositoryRoot] } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
