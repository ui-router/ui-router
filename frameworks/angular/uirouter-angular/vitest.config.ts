import { defineConfig } from 'vitest/config';
import angular from '@analogjs/vite-plugin-angular';
import sourceAliases from '../../../tools/source-aliases.cjs';

const source = sourceAliases.vitestConfigFor('@uirouter/angular');

export default defineConfig({
  plugins: [source.typescriptPlugin, angular({ tsconfig: './tsconfig.spec.json' }), source.watchPlugin],
  resolve: { alias: source.aliases },
  server: { fs: { allow: [source.repositoryRoot] } },
  test: {
    globals: true,
    environment: 'jsdom',
    testTimeout: 10000, // 10 second timeout for async Angular tests
    projects: [
      {
        extends: true,
        test: {
          name: 'zone',
          include: ['test/**/*.spec.ts'],
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'zoneless',
          include: ['test-zoneless/**/*.spec.ts'],
          setupFiles: ['./test-zoneless/setup.ts'],
        },
      },
    ],
  },
});
