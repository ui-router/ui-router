import { defineConfig } from 'vitest/config';
import sourceAliases from '../../tools/source-aliases.cjs';

const source = sourceAliases.vitestConfigFor('@uirouter/sticky-states');

export default defineConfig({
  plugins: source.plugins,
  resolve: { alias: source.aliases },
  server: { fs: { allow: [source.repositoryRoot] } },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*Spec.ts', 'test/**/*.{test,spec}.{js,ts}'],
    testTimeout: 1000,
  },
});
