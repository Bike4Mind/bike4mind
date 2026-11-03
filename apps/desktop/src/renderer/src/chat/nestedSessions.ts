import { useCallback, useSyncExternalStore } from 'react';

/**
 * Two pieces of per-machine sidebar state for sessions an agent spawned: whether they nest under
 * the session that started them at all, and which parents the user has folded shut.
 *
 * localStorage and a store with subscribers, as with worktreeDefault.ts: the Settings switch and
 * the sidebar read the preference independently.
 */

const NESTED_KEY = 'b4m.sidebar.nestSpawned';
const COLLAPSED_KEY = 'b4m.sidebar.collapsedParents';

/** Bounds what an old install accumulates; a forgotten fold only comes back open. */
const MAX_REMEMBERED_FOLDS = 500;

/** Defaults ON: flat is the opt-out. */
export function parseStoredNesting(raw: string | null): boolean {
  return raw !== '0';
}

export function parseStoredFolds(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function nestedSessionsSummary(enabled: boolean): string {
  return enabled
    ? 'Sessions an agent starts sit under the one that started them'
    : 'Off, every session gets its own row';
}

let nested = read(NESTED_KEY, parseStoredNesting, true);
let folded = read(COLLAPSED_KEY, parseStoredFolds, new Set<string>());
const listeners = new Set<() => void>();

function read<T>(key: string, parse: (raw: string | null) => T, fallback: T): T {
  try {
    return parse(window.localStorage.getItem(key));
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Kept for this run; losing it on the next launch beats throwing out of a click.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function nestingEnabled(): boolean {
  return nested;
}

export function setNestingEnabled(next: boolean): void {
  if (next === nested) return;
  nested = next;
  write(NESTED_KEY, next ? '1' : '0');
  notify();
}

export function foldedParents(): ReadonlySet<string> {
  return folded;
}

export function toggleFolded(sessionId: string): void {
  const next = new Set(folded);
  if (next.has(sessionId)) next.delete(sessionId);
  else next.add(sessionId);
  // A Set iterates in insertion order, so the oldest folds are the ones dropped.
  folded = new Set([...next].slice(-MAX_REMEMBERED_FOLDS));
  write(COLLAPSED_KEY, JSON.stringify([...folded]));
  notify();
}

/** The preference and its toggle; re-renders every reader when either changes it. */
export function useNestedSessions(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, nestingEnabled, nestingEnabled);
  const toggle = useCallback(() => setNestingEnabled(!nestingEnabled()), []);
  return [value, toggle];
}

/** Parents shown shut. A new Set on every change, so it can sit in a dependency array. */
export function useFoldedParents(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, foldedParents, foldedParents);
}
