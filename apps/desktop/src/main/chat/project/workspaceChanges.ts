import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatProject } from '@shared/chat';
import type { ChangedFile, WorkspaceChanges } from '@shared/workspaceChanges';
import { git, isGitRepository, resolveBaseRef } from './git';

/** Files sent to the renderer. The totals still cover every file; only the list is cut. */
const MAX_LISTED_FILES = 200;

/** Bytes read per untracked file. A stray multi-GB dump is undercounted rather than read every turn. */
const MAX_UNTRACKED_BYTES = 2_000_000;

/**
 * Bytes read across ALL untracked files per reading. This runs at the end of every reply, so a
 * tree full of unignored build output must cost a bounded read, not one proportional to it; past
 * the budget the rest are listed with 0 lines.
 */
const UNTRACKED_BYTE_BUDGET = 8_000_000;

const CHUNK_BYTES = 64 * 1024;

/**
 * `git diff --numstat -z --no-renames` output, one `added\tremoved\tpath\0` record per file.
 * `--no-renames` is what keeps every record that shape: a rename would otherwise spread over
 * three NUL-separated fields. A binary file reads `-\t-\tpath`.
 */
export function parseNumstat(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const record of stdout.split('\0')) {
    const first = record.indexOf('\t');
    const second = record.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    const removed = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (!path) continue;
    if (added === '-' && removed === '-') {
      files.push({ path, added: 0, removed: 0, binary: true });
      continue;
    }
    files.push({ path, added: Number.parseInt(added, 10) || 0, removed: Number.parseInt(removed, 10) || 0 });
  }
  return files;
}

function nulSeparated(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

function uncounted(path: string): ChangedFile {
  return { path, added: 0, removed: 0, untracked: true };
}

/**
 * Lines in an untracked file, counted the way git would once it is added: one per newline, plus
 * one for a final line with no newline. A NUL in the first chunk marks it binary, as git decides.
 *
 * Only a regular file is opened. lstat, not stat: opening follows a symlink, and opening a FIFO
 * for reading blocks until something writes to it - which would hang this reading for good.
 */
export async function countUntrackedFile(
  directory: string,
  path: string,
  maxBytes = MAX_UNTRACKED_BYTES
): Promise<{ file: ChangedFile; bytesRead: number }> {
  const absolute = join(directory, path);
  if (!(await lstat(absolute)).isFile()) return { file: uncounted(path), bytesRead: 0 };

  const handle = await open(absolute, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let lines = 0;
    let read = 0;
    let last = -1;
    while (read < maxBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, maxBytes - read), read);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (read === 0 && chunk.includes(0)) {
        return { file: { path, added: 0, removed: 0, binary: true, untracked: true }, bytesRead };
      }
      for (const byte of chunk) if (byte === 0x0a) lines++;
      last = chunk[bytesRead - 1];
      read += bytesRead;
    }
    if (read > 0 && last !== 0x0a) lines++;
    return { file: { path, added: lines, removed: 0, untracked: true }, bytesRead: read };
  } finally {
    await handle.close();
  }
}

/** One file at a time, so the budget is spent in order and no more than one descriptor is open. */
async function countUntracked(directory: string, paths: readonly string[]): Promise<ChangedFile[]> {
  let budget = UNTRACKED_BYTE_BUDGET;
  const files: ChangedFile[] = [];
  for (const path of paths) {
    if (budget <= 0) {
      files.push(uncounted(path));
      continue;
    }
    try {
      const { file, bytesRead } = await countUntrackedFile(directory, path, Math.min(MAX_UNTRACKED_BYTES, budget));
      budget -= bytesRead;
      files.push(file);
    } catch {
      // Deleted between the listing and the read, or unreadable: still a change, just uncounted.
      files.push(uncounted(path));
    }
  }
  return files;
}

async function refExists(directory: string, ref: string): Promise<boolean> {
  try {
    await git(directory, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ref the session's changes are measured from.
 *
 * A worktree session names its base, and the remote copy of it is preferred: the worktree was cut
 * from the remote ref (see git.resolveBaseRef), so a stale local `main` would count every upstream
 * commit since as this session's work. An in-place session falls back to the repository default,
 * which is what a pull request from its branch would be opened against.
 */
async function baseRefFor(project: ChatProject): Promise<string> {
  const directory = project.workingDirectory;
  const named = project.workspace && project.branch ? [`origin/${project.branch}`, project.branch] : [];
  for (const candidate of named) {
    if (await refExists(directory, candidate)) return candidate;
  }
  return resolveBaseRef(directory);
}

/**
 * Where HEAD forked from the base. Unrelated histories have none, and then only what is
 * uncommitted is this session's to report.
 */
async function forkPoint(directory: string, base: string): Promise<string> {
  try {
    return (await git(directory, ['merge-base', 'HEAD', base])).trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * What the session's working directory has that its base does not, or null when there is
 * nothing to show: no project, a worktree not cut yet, a folder that is not a repository, or a
 * tree identical to the base.
 *
 * Throws a GitError when git cannot answer (a repository with no commits, say); the caller decides
 * how loudly to say so.
 */
export async function readWorkspaceChanges(project: ChatProject | undefined): Promise<WorkspaceChanges | null> {
  if (!project) return null;
  // The toggle is on but the first turn has not cut the worktree, so `workingDirectory` is still
  // the shared checkout - and its dirty state is not anything this session did.
  if (project.workspace && !project.workspaceBranch) return null;

  const directory = project.workingDirectory;
  // A plain folder is an ordinary project, not a failure to report on every turn.
  if (!(await isGitRepository(directory))) return null;
  const base = await baseRefFor(project);
  const since = await forkPoint(directory, base);

  const [numstat, untrackedList, status, ahead] = await Promise.all([
    git(directory, ['diff', '--numstat', '-z', '--no-renames', '--no-ext-diff', since, '--']),
    git(directory, ['ls-files', '--others', '--exclude-standard', '-z']),
    git(directory, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']),
    git(directory, ['rev-list', '--count', `${since}..HEAD`]),
  ]);

  const untracked = await countUntracked(directory, nulSeparated(untrackedList));

  // Byte order, as git sorts its own listings, so untracked files interleave where git would put them.
  const files = [...parseNumstat(numstat), ...untracked].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  if (files.length === 0) return null;

  return {
    base,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    fileCount: files.length,
    files: files.slice(0, MAX_LISTED_FILES),
    commitsAhead: Number.parseInt(ahead.trim(), 10) || 0,
    uncommitted: nulSeparated(status).length,
  };
}
