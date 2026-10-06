import path from 'path';
import { GITHUB_LAKE_FILE_RULES } from '@bike4mind/common';

// Re-exported so every server consumer keeps importing the rules from the filter that applies them,
// while the create wizard reads the same constant out of @bike4mind/common.
export { GITHUB_LAKE_FILE_RULES };

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
  if (segments.some(segment => DENIED_SEGMENTS.has(segment.toLowerCase()))) return { ok: false, reason: 'denied_path' };
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
