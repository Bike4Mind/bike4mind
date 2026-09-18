import type { Dirent } from 'fs';
import fs from 'fs/promises';
import path from 'path';

type EntryKind = 'file' | 'directory' | 'other';

type DirentLike = {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/**
 * Classify a directory entry, resolving symlinks by their target.
 *
 * `fs.readdir(withFileTypes)` builds each Dirent from the entry itself, never
 * the link target, so a symlink reports `isFile() === false` AND
 * `isDirectory() === false`. A walk keyed off those two predicates alone skips
 * every symlinked entry.
 */
async function classifyEntry(fullPath: string, entry: DirentLike): Promise<EntryKind> {
  if (!entry.isSymbolicLink()) {
    if (entry.isDirectory()) return 'directory';
    return entry.isFile() ? 'file' : 'other';
  }

  try {
    // stat() follows the link; Dirent/lstat() would not.
    const stats = await fs.stat(fullPath);
    if (stats.isDirectory()) return 'directory';
    return stats.isFile() ? 'file' : 'other';
  } catch {
    return 'other'; // broken link - nothing to load
  }
}

/**
 * Recursively collect every `.md` file under `directory`, following symlinks.
 *
 * Symlink support is load-bearing, not a nicety: dotfile managers (nix
 * home-manager, chezmoi, a plain dotfiles repo) materialize
 * `~/.claude/skills/<name>/SKILL.md` as a symlink into an immutable store, so a
 * walk that only accepts real files finds zero global skills on those machines.
 *
 * Directories are deduped by realpath so a cyclic link cannot spin forever.
 *
 * `containmentRoot` scopes symlink following to a trust domain: when set, any
 * entry (file OR directory) whose realpath escapes the root is refused, so a
 * hostile clone cannot point a project SKILL.md/command/agent at a file outside
 * the checkout. Global dirs omit it - that is where dotfile managers legitimately
 * symlink into an out-of-tree immutable store.
 */
export async function findMarkdownFiles(
  directory: string,
  visitedRealPaths: Set<string> = new Set(),
  containmentRoot?: string
): Promise<string[]> {
  const files: string[] = [];

  // Resolve the containment boundary once; realpath is idempotent so threading
  // the resolved value through recursion keeps every level checking the same root.
  let realRoot: string | undefined;
  if (containmentRoot !== undefined) {
    try {
      realRoot = await fs.realpath(containmentRoot);
    } catch {
      return files; // Containment requested but root is unresolvable - refuse all.
    }
  }

  try {
    const realDirectory = await fs.realpath(directory);
    if (visitedRealPaths.has(realDirectory)) {
      return files;
    }
    visitedRealPaths.add(realDirectory);
  } catch {
    // Unreadable path - let readdir below surface it through its own handling.
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    console.warn(`Error reading directory ${directory}:`, error instanceof Error ? error.message : String(error));
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const kind = await classifyEntry(fullPath, entry);
    if (kind === 'other') continue;

    if (realRoot !== undefined) {
      let realEntry: string;
      try {
        realEntry = await fs.realpath(fullPath);
      } catch {
        continue; // Unresolvable target - skip.
      }
      if (realEntry !== realRoot && !realEntry.startsWith(realRoot + path.sep)) {
        console.warn(`Skipping ${fullPath}: symlink target escapes ${realRoot}`);
        continue;
      }
    }

    if (kind === 'directory') {
      files.push(...(await findMarkdownFiles(fullPath, visitedRealPaths, realRoot)));
    } else if (kind === 'file' && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}
