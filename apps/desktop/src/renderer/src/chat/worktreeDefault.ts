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
 * Whether a session bound to this folder should start with the toggle on.
 *
 * A folder with no branches cannot hold a worktree, and main refuses the request outright there
 * (ChatService.resolveWorkspaceBase), so the preference quietly stands down rather than turning
 * a folder pick into an error the user did not ask for.
 */
export function startsInWorktree(
  preferred: boolean,
  inspected: Pick<ProjectInspection, 'isRepository' | 'branches'>
): boolean {
  return preferred && inspected.isRepository && inspected.branches.length > 0;
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
  const value = useSyncExternalStore(subscribe, worktreeByDefault, worktreeByDefault);
  const toggle = useCallback(() => setWorktreeByDefault(!worktreeByDefault()), []);
  return [value, toggle];
}
