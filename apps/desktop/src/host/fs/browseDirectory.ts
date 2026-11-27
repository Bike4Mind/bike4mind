import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Enough for any folder a person picks a project from by eye; past it the listing says it was cut. */
export const BROWSE_ENTRY_LIMIT = 1000;

export type BrowsedDirectory = {
  name: string;
  path: string;
  /** A repository root: it holds a `.git` directory, or the `.git` file of a worktree. */
  isGitRepository: boolean;
  isHidden: boolean;
  /** Listed through a symbolic link; `path` keeps the link's name, and browsing it resolves the target. */
  isSymlink: boolean;
};

export type DirectoryListing = {
  /** Absolute, with symbolic links resolved. */
  path: string;
  /** Null at the filesystem root. */
  parent: string | null;
  entries: BrowsedDirectory[];
  truncated: boolean;
};

export type BrowseFailureReason = 'notFound' | 'notDirectory' | 'permissionDenied';

export type BrowseDirectoryResult =
  { ok: true; listing: DirectoryListing } | { ok: false; reason: BrowseFailureReason; path: string };

type BrowseOptions = { homeDirectory: string; limit?: number };

/**
 * The sub-directories of `path` (the home directory when absent), for a client choosing a folder
 * on a host it cannot open a native picker on. Never reads file contents. `~` and relative paths
 * are taken from the home directory, since a remote client has no working directory here.
 */
export async function browseDirectory(
  path: string | undefined,
  options: BrowseOptions
): Promise<BrowseDirectoryResult> {
  const requested = expandHome(path?.trim() || '~', options.homeDirectory);
  let resolved: string;
  let dirents: Dirent[];
  try {
    resolved = await realpath(requested);
    if (!(await stat(resolved)).isDirectory()) return { ok: false, reason: 'notDirectory', path: resolved };
    dirents = await readdir(resolved, { withFileTypes: true });
  } catch (error) {
    const reason = failureReason(error);
    if (!reason) throw error;
    return { ok: false, reason, path: requested };
  }

  const limit = options.limit ?? BROWSE_ENTRY_LIMIT;
  const candidates = dirents
    .filter(dirent => dirent.isDirectory() || dirent.isSymbolicLink())
    .sort(byVisibilityThenName);
  const chosen: Dirent[] = [];
  let next = 0;
  for (; next < candidates.length && chosen.length < limit; next++) {
    if (await isDirectoryEntry(resolved, candidates[next])) chosen.push(candidates[next]);
  }
  const truncated = await someDirectoryIn(resolved, candidates.slice(next));

  const entries = await Promise.all(
    chosen.map(async (dirent): Promise<BrowsedDirectory> => {
      const entryPath = join(resolved, dirent.name);
      return {
        name: dirent.name,
        path: entryPath,
        isGitRepository: await exists(join(entryPath, '.git')),
        isHidden: dirent.name.startsWith('.'),
        isSymlink: dirent.isSymbolicLink(),
      };
    })
  );
  const parent = dirname(resolved);
  return { ok: true, listing: { path: resolved, parent: parent === resolved ? null : parent, entries, truncated } };
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === '~') return homeDirectory;
  if (path.startsWith('~/')) return join(homeDirectory, path.slice(2));
  return resolve(homeDirectory, path);
}

function failureReason(error: unknown): BrowseFailureReason | null {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
    case 'ELOOP':
      return 'notFound';
    case 'EACCES':
    case 'EPERM':
      return 'permissionDenied';
    default:
      return null;
  }
}

function byVisibilityThenName(left: Dirent, right: Dirent): number {
  const hidden = Number(left.name.startsWith('.')) - Number(right.name.startsWith('.'));
  return hidden || left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true });
}

/** A symbolic link counts when it resolves to a directory; a dangling one is left out. */
async function isDirectoryEntry(directory: string, dirent: Dirent): Promise<boolean> {
  if (dirent.isDirectory()) return true;
  try {
    return (await stat(join(directory, dirent.name))).isDirectory();
  } catch {
    return false;
  }
}

async function someDirectoryIn(directory: string, rest: Dirent[]): Promise<boolean> {
  for (const dirent of rest) if (await isDirectoryEntry(directory, dirent)) return true;
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
