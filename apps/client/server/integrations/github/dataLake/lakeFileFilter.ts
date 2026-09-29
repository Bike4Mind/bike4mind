import path from 'path';

/** What a GitHub-fed lake ingests. The one place the allowlist, denylists and caps live. */
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

export type GitHubTreeEntry = { path?: string; mode?: string; type?: string; sha?: string; size?: number };
export type GitHubLakeCandidate = { path: string; sha: string; size: number };
export type TreeEntryRejection = 'not_blob' | 'symlink' | 'denied_path' | 'lockfile' | 'extension' | 'oversized';

const EXTENSIONS = new Set<string>(GITHUB_LAKE_FILE_RULES.extensions);
// Name lists match case-insensitively: repos ship `readme`, `Readme`, `gemfile.lock` as often as the canonical case.
const EXTENSIONLESS_NAMES = new Set<string>(GITHUB_LAKE_FILE_RULES.extensionlessNames.map(name => name.toLowerCase()));
const DENIED_SEGMENTS = new Set<string>(GITHUB_LAKE_FILE_RULES.deniedPathSegments);
const DENIED_FILE_NAMES = new Set<string>(GITHUB_LAKE_FILE_RULES.deniedFileNames.map(name => name.toLowerCase()));
const SYMLINK_MODE = '120000';
const BINARY_SNIFF_BYTES = 8 * 1024;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

const extensionOf = (filePath: string) => path.posix.extname(filePath).slice(1).toLowerCase();

export function classifyTreeEntry(
  entry: GitHubTreeEntry,
  maxFileBytes: number
): { ok: true; candidate: GitHubLakeCandidate } | { ok: false; reason: TreeEntryRejection } {
  if (entry.type !== 'blob' || !entry.path || !entry.sha) return { ok: false, reason: 'not_blob' };
  if (entry.mode === SYMLINK_MODE) return { ok: false, reason: 'symlink' };
  const segments = entry.path.split('/');
  const fileName = segments[segments.length - 1];
  const lowerFileName = fileName.toLowerCase();
  if (segments.some(segment => DENIED_SEGMENTS.has(segment))) return { ok: false, reason: 'denied_path' };
  if (DENIED_FILE_NAMES.has(lowerFileName)) return { ok: false, reason: 'lockfile' };
  const ext = extensionOf(fileName);
  if (ext ? !EXTENSIONS.has(ext) : !EXTENSIONLESS_NAMES.has(lowerFileName)) return { ok: false, reason: 'extension' };
  const size = entry.size ?? 0;
  if (size > maxFileBytes) return { ok: false, reason: 'oversized' };
  return { ok: true, candidate: { path: entry.path, sha: entry.sha, size } };
}

export function checkLakeFileContent(bytes: Uint8Array): 'ok' | 'binary' | 'invalid_utf8' {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return 'binary';
  try {
    strictUtf8.decode(bytes);
    return 'ok';
  } catch {
    return 'invalid_utf8';
  }
}

export function lakeFileMimeType(filePath: string): string {
  const ext = extensionOf(filePath);
  if (ext === 'md' || ext === 'mdx') return 'text/markdown';
  if (ext === 'json') return 'application/json';
  // Not mime-types: it maps several allowlisted source extensions to non-text types (.ts is video/mp2t),
  // which the chunker (fab-pipeline chunk.ts) refuses.
  return 'text/plain';
}
