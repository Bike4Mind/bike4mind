import path from 'path';

/**
 * True when `target` is `root` itself or nested beneath it. Both must be
 * absolute; callers resolving symlinks pass realpath'd paths, callers doing
 * lexical containment pass resolved paths. Root-aware: a `/` root already ends
 * in the separator, so a second one is not appended (that would yield `//`,
 * which no real path starts with, and refuse everything). Single source for the
 * containment math shared by CheckpointStore, findMarkdownFiles, and fileSearch.
 */
export function isPathWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}
