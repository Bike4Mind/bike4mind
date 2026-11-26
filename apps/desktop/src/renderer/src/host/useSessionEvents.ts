import { useEffect, useMemo, useRef } from 'react';
import type { ChatStreamEvent } from '@shared/chat';
import { sessionEvents, type SessionEventHub } from './sessionEvents';
import { hostForSession } from './sessionHost';

export type SessionEventCallbacks = {
  event(event: ChatStreamEvent): void;
  resync?(): void;
};

/**
 * `callbacks` hears the session's events while it is mounted and `sessionId` is set. The callbacks
 * are read on each event, so passing new ones does not resubscribe.
 */
export function useSessionEvents(
  sessionId: string | null | undefined,
  callbacks: SessionEventCallbacks,
  hub: SessionEventHub = sessionEvents
): void {
  const latest = useRef(callbacks);
  latest.current = callbacks;

  useEffect(() => {
    if (!sessionId) return;
    return hub.subscribe(
      { hostId: hostForSession(sessionId), sessionId },
      { event: event => latest.current.event(event), resync: () => latest.current.resync?.() }
    );
  }, [sessionId, hub]);
}

/**
 * As useSessionEvents, for a changing set of sessions: a session joining the set is subscribed and
 * one leaving it released, without touching the rest.
 */
export function useSessionsEvents(
  sessionIds: ReadonlySet<string>,
  onEvent: (event: ChatStreamEvent) => void,
  hub: SessionEventHub = sessionEvents
): void {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  const held = useRef(new Map<string, () => void>());

  // Every list change can rebuild the set, so the subscriptions follow its contents.
  const key = useMemo(() => [...sessionIds].sort().join('\n'), [sessionIds]);

  useEffect(() => {
    const wanted = new Set(key ? key.split('\n') : []);
    for (const [sessionId, release] of held.current) {
      if (wanted.has(sessionId)) continue;
      release();
      held.current.delete(sessionId);
    }
    for (const sessionId of wanted) {
      if (held.current.has(sessionId)) continue;
      held.current.set(
        sessionId,
        hub.subscribe({ hostId: hostForSession(sessionId), sessionId }, { event: event => latest.current(event) })
      );
    }
  }, [key, hub]);

  useEffect(() => {
    const subscriptions = held.current;
    return () => {
      for (const release of subscriptions.values()) release();
      subscriptions.clear();
    };
  }, []);
}

/** `listener` runs whenever the hub resyncs or resumes a host; see SessionEventHub.onResync. */
export function useHostResync(listener: (hostId: string) => void, hub: SessionEventHub = sessionEvents): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => hub.onResync(hostId => latest.current(hostId)), [hub]);
}
