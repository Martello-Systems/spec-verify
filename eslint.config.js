import js from '@eslint/js';

/**
 * Flat ESLint config (ESLint 9+). Plain JavaScript / ESM, matches the house
 * stack (no TypeScript). Lints src, bin, and tests against the recommended
 * ruleset with Node + ESM globals.
 */
export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', '*.tgz'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        // Web-standard globals available in Node 18+ (matches `engines`).
        Response: 'readonly',
        globalThis: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },
];
