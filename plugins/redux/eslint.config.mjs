import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'examples/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['core/**/*.ts', 'react/**/*.{ts,tsx}'],
    rules: {
      // Match the Angular and Sticky States policy for legacy store types.
      '@typescript-eslint/no-explicit-any': 'off',
      // Preserve the Oxc lane's warning severity while migrating the rule engine.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-debugger': 'error',
      'no-console': 'warn',
      eqeqeq: 'error',
    },
  },
  {
    files: ['core/applyHooks.ts'],
    rules: {
      // The existing exported hook API uses Function; changing it needs separate compatibility proof.
      '@typescript-eslint/no-unsafe-function-type': 'off',
    },
  },
);
