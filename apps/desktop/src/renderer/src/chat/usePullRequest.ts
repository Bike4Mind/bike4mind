import { useEffect, useState } from 'react';
import type { PrBarState } from '@shared/pullRequest';

/**
 * The bar for the conversation on screen, kept current by main's pushes.
 *
 * Telling main which conversation is showing is what drives its polling cadence, so this is
 * also the only place that says so: on mount, on every switch, and null on unmount.
 */
export function usePullRequest(sessionId: string | null): PrBarState | null {
  const [state, setState] = useState<PrBarState | null>(null);

  useEffect(() => {
    let current = true;
    setState(null);
    const unsubscribe = window.b4m.pullRequests.onStateChanged(next => {
      if (current && next.sessionId === sessionId) setState(next);
    });
    void window.b4m.pullRequests.watch(sessionId).then(initial => {
      if (current) setState(previous => previous ?? initial);
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [sessionId]);

  useEffect(() => () => void window.b4m.pullRequests.watch(null), []);

  return state;
}
