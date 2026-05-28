// ESLint flat config (ESLint 9+).
//
// Layering choice: start with `tseslint.configs.recommended` (no type-checking
// for speed) plus `stylistic` for opinionated readability. We can ratchet up to
// `recommendedTypeChecked` later if the codebase grows enough to need it.
//
// Layer-boundary enforcement stays in scripts/check-layers.mjs — it runs
// without ESLint installed and gives clearer errors than `no-restricted-imports`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'coverage/',
      'package-lock.json',
      'assets/',
      '*.svg',
      '*.png',
      '*.HEIC',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,

  {
    rules: {
      // We use process.stderr for CLI/server output; console is OK for scripts.
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      // Force `import type { … }` for types so emitted JS stays clean.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Allow `_`-prefixed unused vars (sometimes intentional in handlers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // Empty functions are sometimes useful as no-op defaults.
      '@typescript-eslint/no-empty-function': 'off',
      // Non-null assertions are intentional at SDK boundaries; downgrade to warn.
      '@typescript-eslint/no-non-null-assertion': 'warn',
    },
  },

  // Tests get a relaxed ruleset — they intentionally probe edge cases.
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  // Build/maintenance scripts written in plain ESM.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // Dashboard frontend — browser JS, no TypeScript, runs in a tab.
  {
    files: ['src/dashboard/public/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // app.js is plain JS, the TS-eslint rules don't apply.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // Prettier compat must come last so it overrides any stylistic rules
  // that would conflict with the formatter.
  prettier,
);
