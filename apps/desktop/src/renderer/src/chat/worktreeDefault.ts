import { useCallback, useSyncExternalStore } from 'react';
import type { ProjectInspection } from '@shared/chat';

/**
 * Whether a Code session that is given a folder starts with the worktree toggle on.
 *
 * Per-machine UI state, so localStorage, the same as the prompt-suggestion switch (see
 * promptSuggestions.ts). It is only ever read at the two moments a session gets a folder - the
 * chip row's folder pick and a project group's "+" - and becomes that session's own toggle
 * there, so changing it never touches a session that already exists.
 *
 * A store with subscribers rather than a hook's own state, because the Settings switch and those
 * two call sites read it independently.
 */

const STORAGE_KEY = 'b4m.code.worktreeByDefault';

/** Defaults OFF: a worktree is a branch and a folder on disk, which is opt-in. */
export function parseStoredWorktreeDefault(raw: string | null): boolean {
  return raw === '1';
}

export function worktreeDefaultSummary(enabled: boolean): string {
  return enabled ? 'New Code sessions start in their own worktree' : 'Off';
}

/**
 * Whether this folder can hold a worktree: a repository with a branch to cut one from.
 *
 * Mirrors the local branches main's `defaultBaseBranch` will base on - `main`, `master`, or the
 * checked-out branch. The remote default is not visible from here, so a repo checked out
 * detached whose only local branch is, say, `develop` stands down: that skips the default for
 * the folder, never fails the pick. Main refuses a worktree with no base outright (see
 * ChatService.resolveWorkspaceBase), so the two rules must stay in sync.
 */
export function canHoldWorktree(
  inspected: Pick<ProjectInspection, 'isRepository' | 'branches' | 'currentBranch'>
): boolean {
  if (!inspected.isRepository) return false;
  return (
    inspected.branches.includes('main') || inspected.branches.includes('master') || inspected.currentBranch !== null
  );
}

let enabled = readStored();
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return parseStoredWorktreeDefault(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked: off, which is the default anyway.
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function worktreeByDefault(): boolean {
  return enabled;
}

export function setWorktreeByDefault(next: boolean): void {
  if (next === enabled) return;
  enabled = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a settings click.
  }
  for (const listener of listeners) listener();
}

/** The setting and its toggle; re-renders every reader when either changes it. */
export function useWorktreeByDefault(): [boolean, () => void] {
  // The third argument is the same reader, for the reason given at usePromptSuggestions: the
  // value is a module global rather than anything React renders around, so a string render sees
  // what a live one would; without it React refuses to render this hook outside the browser.
  const value = useSyncExternalStore(subscribe, worktreeByDefault, worktreeByDefault);
  const toggle = useCallback(() => setWorktreeByDefault(!worktreeByDefault()), []);
  return [value, toggle];
}
