import type { ChatProject } from './chat';

export type WorkspaceOwner = {
  project?: ChatProject;
  directories: readonly string[];
  title: string;
};

export type WorktreeRemoval = {
  path: string;
  branch: string;
  safe: boolean;
  reason: string | null;
};

export type WorktreeState = 'clean' | 'dirty' | 'unpushed' | 'unverified' | 'owned' | 'nested' | 'foreign';

/** A checkout under a project's app worktree root, with whether a conversation still uses it. */
export type AppWorktree = WorktreeRemoval & {
  /** Display name of the project that uses it, or null when nothing does. */
  owner: string | null;
  lastCommit: string | null;
  state: WorktreeState;
};

export type WorktreeSweepStatus = 'removed' | 'skipped' | 'failed';

export type WorktreeSweepItem = {
  path: string;
  branch: string;
  status: WorktreeSweepStatus;
  message: string | null;
};
