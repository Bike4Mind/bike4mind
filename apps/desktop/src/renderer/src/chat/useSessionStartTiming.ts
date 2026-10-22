import { useCallback, useEffect, useRef } from 'react';
import type { ChatSessionSummary } from '@shared/chat';

/** Read over CDP with `performance.getEntriesByName(SESSION_ROW_MEASURE)`; nothing is logged. */
export const SESSION_ROW_MEASURE = 'b4m:session-row';

/**
 * Click-to-row time for a session start, as a User Timing measure.
 *
 * The ids listed at the click are kept so the row that appears afterwards is recognised as the
 * new one, whichever path listed it: a create returns it, a spawn arrives on a status reload.
 * Nothing is compared while no start is pending, so a sidebar of hundreds pays nothing.
 */
export function useSessionStartTiming(sessions: readonly ChatSessionSummary[]): (kind: string) => void {
  const pending = useRef<{ kind: string; at: number; known: Set<string> } | null>(null);
  const latest = useRef(sessions);
  latest.current = sessions;

  useEffect(() => {
    const start = pending.current;
    if (!start) return;
    const added = sessions.find(session => !start.known.has(session.id));
    if (!added) return;
    pending.current = null;
    performance.measure(SESSION_ROW_MEASURE, { start: start.at, end: performance.now(), detail: start.kind });
  }, [sessions]);

  return useCallback((kind: string) => {
    pending.current = { kind, at: performance.now(), known: new Set(latest.current.map(session => session.id)) };
  }, []);
}
