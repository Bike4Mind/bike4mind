/**
 * Next.js ESLint configuration
 * Extends TypeScript config with Next.js-specific rules
 *
 * Note: This config uses __dirname for Next.js settings.
 * When extending, ensure you set `settings.next.rootDir` in your local config.
 */
const typescript = require('./typescript');

module.exports = {
  root: true,
  extends: ['next/core-web-vitals'],
  ignorePatterns: ['**/public/**', '**/sst-env.d.ts'],
  rules: {
    ...typescript.rules,
    '@next/next/no-img-element': 'off',
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: 'next/router',
            message:
              'Use routing/navigation hooks from @tanstack/react-router instead of Next.js router hooks. We now use Tanstack Router for SPA routing.',
          },
          {
            name: 'next/navigation',
            message:
              'Use routing/navigation hooks from @tanstack/react-router instead of Next.js router hooks. We now use Tanstack Router for SPA routing.',
          },
        ],
        patterns: [
          {
            group: ['next/router', 'next/navigation'],
            message:
              'Use routing/navigation hooks from @tanstack/react-router instead of Next.js router hooks. We now use Tanstack Router for SPA routing.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['*.ts', '*.tsx'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      rules: {
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            ignoreRestSiblings: true,
            destructuredArrayIgnorePattern: '^_',
            argsIgnorePattern: '^_',
            args: 'none',
          },
        ],
      },
    },
  ],
};
