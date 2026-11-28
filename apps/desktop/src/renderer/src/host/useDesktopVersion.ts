import { useSyncExternalStore } from 'react';

/** The app version, read from main once and shared by every badge and row; empty until main answers. */
let version = '';
let requested = false;
const listeners = new Set<() => void>();

function request(): void {
  if (requested) return;
  requested = true;
  window.b4m.update
    .getState()
    .then(state => {
      // A reply without a version reads as unknown rather than breaking every badge.
      version = typeof state.currentVersion === 'string' ? state.currentVersion : '';
      for (const listener of listeners) listener();
    })
    .catch((error: unknown) => {
      requested = false;
      console.warn('Could not read the app version', error);
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  request();
  return () => listeners.delete(listener);
}

/** Forgets the cached version so the next subscriber reads it again. For tests. */
export function resetDesktopVersion(): void {
  version = '';
  requested = false;
}

/**
 * This Desktop's version, the one a host's program is compared with. Empty until main answers,
 * which reads as "unknown": nothing is offered an update on a guess.
 */
export function useDesktopVersion(): string {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  );
}
