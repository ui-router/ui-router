import { defineConfig } from 'vitest/config';
import sourceAliases from '../../tools/source-aliases.cjs';

const source = sourceAliases.vitestConfigFor('@uirouter/rx');

export default defineConfig({
  plugins: source.plugins,
  resolve: { alias: source.aliases },
  server: { fs: { allow: [source.repositoryRoot] } },
  test: {
    globals: true,
    restoreMocks: true,
  },
});
