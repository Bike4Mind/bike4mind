import { useCallback, useSyncExternalStore } from 'react';

/**
 * Whether sessions imported from Claude sit in their project groups in the sidebar (the
 * default), or in their own collapsed "Imported from Claude" section. Per-machine UI state, read
 * by both Settings and the sidebar, hence a store with subscribers - see promptSuggestions.ts.
 */
const STORAGE_KEY = 'b4m.sidebar.importedInline';

let inline = readStored();
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setImportedInline(next: boolean): void {
  if (next === inline) return;
  inline = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Kept for this run only.
  }
  for (const listener of listeners) listener();
}

export function useImportedInline(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => inline,
    () => true
  );
  const set = useCallback((next: boolean) => setImportedInline(next), []);
  return [value, set];
}
