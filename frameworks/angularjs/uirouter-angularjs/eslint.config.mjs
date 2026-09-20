import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import typescriptPrettier from 'eslint-config-prettier/@typescript-eslint.js';

export default tseslint.config(
  { ignores: ['lib/**', 'lib-esm/**', 'release/**', 'build/**', '_doc/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended, prettier, typescriptPrettier],
    languageOptions: { globals: globals.browser },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // ESLint 8 ignored unused catch parameters by default.
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
      // Preserve the former ban-types exception for the public Function-based API.
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
);
