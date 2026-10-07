/**
 * Mount-time reconnect probe: on session change, ask the server whether an
 * in-flight execution exists for this session. The server replies with
 * `reconnect_result`, which the subscriber pipes into the store via
 * `hydrateFromReconnect` - that stamps the sessionId onto the execution so
 * ActiveAgentExecutions renders it. No-op when `found: false`.
 *
 * Call it from SessionMiddle, not from anything inside ChatHistory's footer:
 * ChatHistory remounts the footer on its empty-fallback -> Virtuoso swap, so
 * a probe owned by the footer fires again for the same session.
 */

import { useEffect, useRef } from 'react';
import { useAgentExecutionDispatch } from '@client/app/hooks/useAgentExecution';

export function useSessionReconnectProbe(sessionId: string | null | undefined): void {
  const { reconnect } = useAgentExecutionDispatch();

  // The probe effect depends ONLY on `sessionId`. `reconnect` is read
  // through a ref because the dispatcher's identity is stable today
  // (memoised over `sendJsonMessage`) but a future upstream change could
  // make it churn - putting `reconnect` in the deps would then fire
  // reconnect on every render, each call enqueueing another
  // `pendingReconnects` entry and scrambling the FIFO matching with
  // `reconnect_result` events. The sync effect keeps the ref current
  // without writing during render.
  const reconnectRef = useRef(reconnect);
  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);
  useEffect(() => {
    if (!sessionId) return;
    reconnectRef.current(sessionId);
  }, [sessionId]);
}
