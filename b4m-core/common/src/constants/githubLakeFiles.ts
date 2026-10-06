/**
 * What a GitHub-fed data lake ingests: the one place the allowlist, denylists and caps live.
 *
 * Lives in common rather than beside the classifier that applies it
 * (apps/client/server/integrations/github/dataLake/lakeFileFilter.ts, which re-exports this and
 * holds the node-only matching code) so the create wizard's "What gets synced" disclosure can
 * render the real rules instead of a hand-written copy that drifts from them.
 */
export const GITHUB_LAKE_FILE_RULES = {
  extensions: [
    'md',
    'mdx',
    'txt',
    'rst',
    'adoc',
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'py',
    'go',
    'rs',
    'java',
    'kt',
    'rb',
    'php',
    'cs',
    'c',
    'h',
    'cpp',
    'hpp',
    'swift',
    'scala',
    'sh',
    'sql',
    'json',
    'yaml',
    'yml',
    'toml',
    'ini',
  ],
  extensionlessNames: ['README', 'LICENSE', 'Dockerfile', 'Makefile'],
  deniedPathSegments: [
    'node_modules',
    'vendor',
    'dist',
    'build',
    '.git',
    'third_party',
    '.next',
    'target',
    '__pycache__',
  ],
  deniedFileNames: [
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'Cargo.lock',
    'poetry.lock',
    'Gemfile.lock',
    'go.sum',
    'composer.lock',
  ],
  maxFileBytes: 1024 * 1024,
  maxCandidates: 5000,
} as const;
