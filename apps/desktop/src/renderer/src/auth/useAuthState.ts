import { useEffect, useState } from 'react';
import type { AuthState } from '@shared/auth';

/**
 * Mirrors the main process's auth state. Main pushes every change, so this never polls; the
 * one-shot `getState` only covers the window that mounts after a change was already pushed.
 */
export function useAuthState(): AuthState | null {
  const [state, setState] = useState<AuthState | null>(null);

  useEffect(() => {
    const unsubscribe = window.b4m.auth.onStateChanged(setState);
    // `current ?? initial` so a push that lands before this resolves is not clobbered by the
    // older snapshot this request was already carrying.
    void window.b4m.auth.getState().then(initial => setState(current => current ?? initial));
    return unsubscribe;
  }, []);

  return state;
}
