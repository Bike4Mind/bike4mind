import { useEffect, useState } from 'react';
import type { PrBarState, PrSummary } from '@shared/pullRequest';
import { applyPrSummaryEvents } from './prSummaries';

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

/**
 * Every conversation's PR icon for the sidebar: one map for the whole list, kept by main's
 * pushes. Main builds it from what the monitor already holds, so nothing here reads GitHub.
 * Subscribed before the snapshot is read, which is applied only to conversations no push has
 * covered; see useSessionStatuses for the same ordering.
 */
export function usePrSummaries(): ReadonlyMap<string, PrSummary> {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, PrSummary>>(() => new Map());

  useEffect(() => {
    let live = true;
    const pushed = new Set<string>();
    const unsubscribe = window.b4m.pullRequests.onSummaryChanged(event => {
      pushed.add(event.sessionId);
      setSummaries(current => applyPrSummaryEvents(current, [event]));
    });
    void window.b4m.pullRequests.getSummaries().then(snapshot => {
      if (!live) return;
      setSummaries(current =>
        applyPrSummaryEvents(
          current,
          snapshot.filter(event => !pushed.has(event.sessionId))
        )
      );
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return summaries;
}
