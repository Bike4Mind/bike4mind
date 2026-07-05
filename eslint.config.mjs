import { defineConfig, globalIgnores } from 'eslint/config';
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

/**
 * ESLint Flat Config for Bike4Mind Monorepo
 *
 * Consolidated configuration for:
 * - Root TypeScript files
 * - apps/client (Next.js + React)
 * - b4m-core packages (with import restrictions)
 * - packages/*
 */
// B4Mv3 Track 1 — deprecated facade import restrictions.
// Extracted as consts so they can be spread into blocks that also carry other rules.
// flat-config last-rule-wins means only the last matching no-restricted-imports rule
// takes effect per file — each block covering a given file scope must carry ALL restrictions.
const b4mv3RestrictedPaths = [
  // @bike4mind/utils deprecated symbols
  {
    name: '@bike4mind/utils',
    importNames: ['Logger', 'ILogger', 'LogLevel'],
    message:
      'Import logging symbols from @bike4mind/observability instead. See B4Mv3 #7842 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  {
    name: '@bike4mind/utils',
    importNames: [
      'SmartChunker',
      'ChunkSchema',
      'Chunk',
      'URL_REGEX',
      'detectURLs',
      'hasURLs',
      'urlExists',
      'fetchAndParseURL',
      'validateUrlForFetch',
      'isPrivateIP',
      'isPrivateOrInternalHostname',
      'EmbeddingFactory',
      'EmbeddingConfig',
      'EmbeddingService',
      'EmbeddingModelProvider',
      'EmbeddingModelInfo',
      'getProviderFromModel',
      'BedrockEmbeddingService',
      'BedrockCredentials',
      'BEDROCK_EMBEDDING_MODEL_MAP',
      'OpenAIEmbeddingService',
      'OPENAI_EMBEDDING_MODEL_MAP',
      'VoyageAIEmbeddingProvider',
      'VOYAGEAI_EMBEDDING_MODEL_MAP',
      'BaseStorage',
      'S3Storage',
    ],
    message:
      'Import from @bike4mind/fab-pipeline instead. See B4Mv3 #7845 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  {
    name: '@bike4mind/utils',
    importNames: [
      'ApiKeyTable',
      'getLlmByModel',
      'getAvailableModels',
      'getExpiringModels',
      'logExpiringModels',
      'resolveDeprecatedModelId',
      'PipelineTimer',
      'ICompletionBackend',
      'ICompletionOptions',
      'ICompletionOptionTools',
      'ICompletionResponse',
      'ICompletionResponseChunk',
      'ITokenizingBackend',
      'CompletionInfo',
      'CompletionCallback',
      'IChoice',
      'IChoiceEnd',
      'IChoiceStream',
      'IChoiceEndStop',
      'IChoiceEndComplete',
      'IChoiceEndToolUse',
      'ChoiceStatus',
      'ChoiceEndReason',
      'DEFAULT_MAX_TOOL_CALLS',
      'DEFAULT_MAX_PARALLEL_TOOLS',
      'OllamaBackend',
      'OpenAIBackend',
      'AnthropicBackend',
      'AnthropicBedrockBackend',
      'AnthropicBatchService',
      'AWSBackend',
      'BFLBackend',
      'GeminiBackend',
      'UndifferentiatedBedrockBackend',
      'XAIBackend',
      'BatchTransformRequest',
      'BatchStatus',
      'BatchItemResult',
      'BatchSubmitResult',
    ],
    message:
      'Import from @bike4mind/llm-adapters instead. See B4Mv3 #7844 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  {
    name: '@bike4mind/utils/llm/backend',
    message:
      'Import from @bike4mind/llm-adapters/backend instead. See B4Mv3 #7844 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  // @bike4mind/services deprecated symbols
  {
    name: '@bike4mind/services',
    importNames: ['AuthTokenGeneratorService'],
    message:
      'Import AuthTokenGeneratorService from @bike4mind/auth instead. See B4Mv3 #7846 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  {
    name: '@bike4mind/services/apiKeyService',
    message:
      'Import from @bike4mind/auth/apiKeyService instead. See B4Mv3 #7846 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  {
    name: '@bike4mind/services/mfaService/utils',
    message:
      'Import from @bike4mind/auth/mfaService/utils instead. See B4Mv3 #7846 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
  {
    name: '@bike4mind/services/utils/crypto',
    message:
      'Import safeCompareTokens from @bike4mind/auth/crypto instead. See B4Mv3 #7846 and docs/architecture/b4mv3-subpath-export-audit.md.',
  },
];

const b4mv3RestrictedPatterns = [
  {
    group: ['@bike4mind/utils/llm/backend/*'],
    message: 'Import from @bike4mind/llm-adapters/backend instead. See B4Mv3 #7844.',
  },
  {
    group: ['@bike4mind/database/src', '@bike4mind/database/src/*', '@bike4mind/database/src/**'],
    message:
      'Import from @bike4mind/database (root) or domain sub-paths (./auth, ./content, ./social, ./billing, ./ai, ./infra). See B4Mv3 #8808.',
  },
  // Note: b4m-core/{common,services,utils} blocks have isolated no-restricted-imports rules that
  // firewall the entire @bike4mind/database package — a deep-path ban there is redundant.
];

// #9627 guardrail — filesystem tree-walking is banned in test files anywhere under
// apps/client/pages/**. Next compiles everything under pages/ as a route and dependency-traces it
// with NFT (Node File Tracing); a test that walks the project tree (readdir/opendir/glob over
// computed paths) defeats NFT static analysis (it can't predict the paths) and traces the WHOLE
// project into the server Lambda, blowing past AWS's 250MB unzipped limit and failing server-side
// preview deploys. fs-scanning tests belong OUTSIDE pages/ (e.g. apps/client/server/__tests__/).
// We target the tree-walk call/import signature rather than the `fs` import itself, so legitimate
// temp-file I/O (writeFileSync/existsSync in files/__tests__/download.test.ts) is not falsely
// flagged. Scope is ALL of pages/ (not just pages/api/) because NFT route-traces the entire pages/
// tree — a walker at pages/__tests__/ would over-trace identically (#9627 bot-review P3).
//
// Covered: bare calls (`readdirSync(dir)`), member calls (`fs.readdirSync(dir)`/`fsPromises.glob`),
// and named imports INCLUDING aliases (`import { readdirSync as walk }`) from (node:)fs[/promises] —
// the import selector matches `imported.name`, so an alias can't bypass it. CJS require destructuring
// (`const { readdirSync } = require('fs')`, incl. aliased `{ readdirSync: walk }`) is covered too.
// Not covered (documented extension point — add a selector here if it appears): third-party globs
// (fast-glob/globby/glob), whose entrypoints are unbounded and risk false positives if name-banned.
const TREE_WALK_NAMES = '^(readdir|readdirSync|opendir|opendirSync|glob|globSync)$';
const WALK_MESSAGE =
  'Do not walk the filesystem (readdir/opendir/glob) in tests under pages/ (#9627): Next traces ' +
  'these as routes, and the dynamic reads pull the whole project into the server Lambda (>250MB, ' +
  'breaks preview deploys). Move fs-scanning tests out of pages/ — e.g. to apps/client/server/__tests__/.';
const noTreeWalkInPagesTests = [
  // bare call: `readdirSync(dir)` (named/destructured import)
  { selector: `CallExpression[callee.name=/${TREE_WALK_NAMES}/]`, message: WALK_MESSAGE },
  // member call: `fs.readdirSync(dir)` / `fsPromises.glob(pat)`
  { selector: `CallExpression[callee.property.name=/${TREE_WALK_NAMES}/]`, message: WALK_MESSAGE },
  // named import incl. alias: `import { readdirSync as walk } from 'node:fs'` (matches imported.name).
  // `.` stands in for `/` in the source regex — esquery's selector parser mis-handles an escaped `\/`.
  {
    selector: `ImportDeclaration[source.value=/^(node:)?fs(.promises)?$/] ImportSpecifier[imported.name=/${TREE_WALK_NAMES}/]`,
    message: WALK_MESSAGE,
  },
  // CJS require destructure: `const { readdirSync } = require('fs')` (incl. aliased `{ readdirSync: walk }`).
  // Matches the property KEY (the original fs export), so an aliased local binding can't bypass it. The
  // plain (non-aliased) call is already caught by the bare-call selector; this also covers the aliased form.
  {
    selector: `VariableDeclarator[init.callee.name='require'][init.arguments.0.value=/^(node:)?fs(.promises)?$/] ObjectPattern Property[key.name=/${TREE_WALK_NAMES}/]`,
    message: WALK_MESSAGE,
  },
];

export default defineConfig([
  // Global ignores (replaces .eslintignore)
  globalIgnores([
    '**/node_modules/**',
    '**/.next/**',
    '**/.open-next/**',
    '**/dist/**',
    '**/build/**',
    '**/.sst/**',
    '**/sst-env.d.ts',
    'apps/client/public/**',
    'apps/client/next.config.js',
    'apps/client/next-i18next.config.js',
    'apps/client/test-csp.js',
    'docs-site/**',
    'commitlint.config.js',
  ]),

  // Base ESLint recommended rules for all JS/TS files
  eslint.configs.recommended,

  // Global rules for ALL files (js, jsx, ts, tsx, mjs, cjs, etc.)
  {
    rules: {
      'no-const-assign': 'off',
      'no-empty': ['error', {
        allowEmptyCatch: true,
      }],
      'no-extra-boolean-cast': 'off',
      'no-fallthrough': ['error', {
        allowEmptyCase: true,
      }],
      'no-prototype-builtins': 'warn',
      'no-useless-escape': 'off',
    },
  },

  // CommonJS files (legacy configs, scripts, etc.)
  {
    files: ['**/*.cjs', 'packages/eslint-config/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },

  // Node.js ESM scripts
  {
    files: ['scripts/**/*.mjs', '**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },

  // TypeScript configuration for all .ts/.tsx files
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),

  // TypeScript custom rules
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          destructuredArrayIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          args: 'none',
          caughtErrors: 'none',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/triple-slash-reference': [
        'error',
        {
          path: 'always',
          types: 'prefer-import',
          lib: 'always',
        },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'warn',
        {
          'ts-ignore': 'allow-with-description',
        },
      ],
      // Allow {} type (replaces the deprecated ban-types rule)
      '@typescript-eslint/no-empty-object-type': [
        'error',
        {
          allowObjectTypes: 'always',
          allowInterfaces: 'always',
        },
      ],
    },
  },

  // Next.js / React configuration for apps/client
  {
    files: ['apps/client/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // Next.js rules
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      '@next/next/no-img-element': 'off',
      '@next/next/no-html-link-for-pages': ['error', 'apps/client/pages'],

      // React rules
      ...reactPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',

      // React Hooks rules
      ...reactHooksPlugin.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/error-boundaries': 'error',
      'react-hooks/preserve-manual-memoization': 'error',

      // Restrict Next.js router imports (use Tanstack Router instead) + B4Mv3 facade guards.
      // b4mv3RestrictedPaths are spread here so apps/client/** (excluded from the B4Mv3 block
      // below) still gets error-severity coverage for all non-server client files.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...b4mv3RestrictedPaths,
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
          patterns: [...b4mv3RestrictedPatterns],
        },
      ],
    },
  },

  // b4m-core/common - restrict database imports
  {
    files: ['b4m-core/common/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@bike4mind/database',
              message:
                'Database imports are restricted in the common package to prevent database configuration leakage.',
            },
            {
              name: 'mongoose',
              message:
                'Database imports are restricted in the common package to prevent database configuration leakage.',
            },
          ],
        },
      ],
    },
  },

  // b4m-core/services - restrict database imports
  {
    files: ['b4m-core/services/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@bike4mind/database',
              message:
                'Database imports are restricted in the services package to prevent database configuration leakage.',
            },
            {
              name: '../../database/src',
              message:
                'Database imports are restricted in the services package to prevent database configuration leakage.',
            },
          ],
        },
      ],
    },
  },

  // Overwatch dependency firewall — prevent non-overwatch code from importing overwatch internals
  // External code should only import from server/overwatch/index.ts barrel
  {
    files: ['apps/client/server/**/*.ts'],
    ignores: [
      'apps/client/server/overwatch/**',
    ],
    rules: {
      // Overwatch barrel restriction + B4Mv3 facade guards.
      // This block is last-rule-wins for apps/client/server/**, so it must carry b4mv3 restrictions
      // that the Next.js block above would otherwise cover for non-server files.
      'no-restricted-imports': [
        'error',
        {
          paths: [...b4mv3RestrictedPaths],
          patterns: [
            {
              group: ['**/overwatch/services/*', '**/overwatch/types'],
              message: 'Import from @server/overwatch barrel (index.ts) only — do not reach into Overwatch internals.',
            },
            ...b4mv3RestrictedPatterns,
          ],
        },
      ],
    },
  },

  // b4m-core/utils - restrict database imports
  {
    files: ['b4m-core/utils/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@bike4mind/database',
              message:
                'Database imports are restricted in the utils package to prevent database configuration leakage.',
            },
            {
              name: 'mongoose',
              message:
                'Database imports are restricted in the utils package to prevent database configuration leakage.',
            },
          ],
        },
      ],
    },
  },

  // React Hooks rules for premium packages (react-hooks plugin is registered under apps/client/**
  // above, but packages/premium/** also contains React components with eslint-disable-next-line
  // react-hooks/... comments — register the plugin here so the rule is known and the disable
  // comments are treated as valid suppressions rather than unknown-rule errors).
  {
    files: ['packages/premium/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // B4Mv3 Track 1 — deprecated facade imports are now errors (transition window closed, #7850).
  // apps/client/** is excluded here because the Next.js block and Overwatch block above spread
  // b4mv3RestrictedPaths/Patterns directly — flat-config last-rule-wins means only the last
  // matching no-restricted-imports rule applies per file.
  {
    files: ['apps/**/*.{ts,tsx}', 'b4m-core/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['apps/client/**', 'b4m-core/utils/**', 'b4m-core/services/**', 'b4m-core/common/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...b4mv3RestrictedPaths],
          patterns: [...b4mv3RestrictedPatterns],
        },
      ],
    },
  },

  // #9627 — ban filesystem tree-walking in test files anywhere under apps/client/pages/**. Uses
  // no-restricted-syntax (a different rule id than no-restricted-imports), so the apps/client
  // Next.js block's import restrictions still apply to these files unchanged. See
  // noTreeWalkInPagesTests above for the over-tracing rationale and coverage notes.
  {
    files: ['apps/client/pages/**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...noTreeWalkInPagesTests],
    },
  },
]);
