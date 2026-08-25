import { defineConfig } from 'vitest/config';
import sourceAliases from '../../tools/source-aliases.cjs';

const source = sourceAliases.vitestConfigFor('@uirouter/redux');

export default defineConfig({
  plugins: source.plugins,
  resolve: { alias: source.aliases, dedupe: ['react', 'react-dom'] },
  server: { fs: { allow: [source.repositoryRoot] } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    include: ['**/__tests__/**/*.{ts,tsx,js}'],
  },
});
