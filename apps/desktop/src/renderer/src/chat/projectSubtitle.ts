import type { ChatProject } from '@shared/chat';

export interface ProjectSubtitle {
  /** The short line under the title, e.g. `bike4mind \u00B7 b4m/fix-the-thing`. */
  label: string;
  /** Where the session's tools run: the tooltip, and what a click copies. */
  path: string;
}

const SEPARATOR = ' \u00B7 ';

/** The last segment of a path, on either separator, ignoring a trailing one. */
export function folderName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * The header subtitle for a Code session: project and branch rather than a raw absolute path,
 * whose useful end is what truncation cuts off first.
 *
 * The branch is shown only once the session is in its own worktree, because only then is it a
 * fact: with the worktree off, `branch` is what the user picked and nothing checks it out, so
 * the checkout may be on anything by now. A worktree recorded before the app cut branches of its
 * own has no `workspaceBranch`, so its folder name - which encodes the branch - stands in.
 */
export function projectSubtitle(
  project: Pick<ChatProject, 'directory' | 'name' | 'workspaceBranch' | 'workingDirectory'>
): ProjectSubtitle {
  const name = project.name.trim() || folderName(project.directory) || folderName(project.workingDirectory);
  const inWorktree = project.workingDirectory !== project.directory;
  const branch = inWorktree ? project.workspaceBranch?.trim() || folderName(project.workingDirectory) : '';
  return {
    label: branch && branch !== name ? `${name}${SEPARATOR}${branch}` : name,
    path: project.workingDirectory,
  };
}
