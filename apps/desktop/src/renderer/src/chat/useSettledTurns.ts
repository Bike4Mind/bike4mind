import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatSessionStatusEvent } from '@shared/chat';
import { hostClient } from '../host/HostClient';
import { useServingHostIds } from '../host/hostRegistry';
import { useHostResync } from '../host/useSessionEvents';

/**
 * Counts turns settling in any session on any host, for what must recheck after one (the credit
 * balance spends across every conversation). Driven by each session's settledTurns counter in its
 * status, so a missed or coalesced push still counts once the next one arrives.
 */
export function useSettledTurns(): number {
  const servingHosts = useServingHostIds();
  const [settled, setSettled] = useState(0);
  const counters = useRef(new SettledTurnCounters());

  useEffect(
    () =>
      hostClient.onNotification('session/statusChanged', ({ event }, hostId) => {
        if (counters.current.observe(hostId, event)) setSettled(count => count + 1);
      }),
    []
  );

  // Each host's counters are read when it joins and after its own resync, never because another
  // host joined or left. A read overtaken by a newer one for its host is dropped.
  const reads = useRef(new Map<string, number>());
  const readHost = useCallback((hostId: string) => {
    const ticket = (reads.current.get(hostId) ?? 0) + 1;
    reads.current.set(hostId, ticket);
    void hostClient
      .request(hostId, 'session/statuses')
      .then(({ statuses }) => {
        if (reads.current.get(hostId) !== ticket) return;
        for (const event of statuses) counters.current.observe(hostId, event);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const wanted = new Set(servingHosts);
    for (const hostId of [...reads.current.keys()]) if (!wanted.has(hostId)) reads.current.delete(hostId);
    for (const hostId of servingHosts) if (!reads.current.has(hostId)) readHost(hostId);
  }, [servingHosts, readHost]);

  // A turn may have settled unheard, and an idle session is not in session/statuses, so a resync
  // counts as one; that host's counters are then read again.
  useHostResync(hostId => {
    setSettled(count => count + 1);
    if (reads.current.has(hostId)) readHost(hostId);
  });

  useEffect(() => () => reads.current.clear(), []);

  return settled;
}

/**
 * The last settledTurns seen per (host, session). A session first seen is recorded, not counted:
 * its counter covers turns from before this window was looking.
 */
export class SettledTurnCounters {
  private readonly counters = new Map<string, number>();

  /** True when `event` shows a turn settled since the last event seen for its session. */
  observe(hostId: string, event: ChatSessionStatusEvent): boolean {
    const key = `${hostId}\n${event.sessionId}`;
    const next = event.settledTurns ?? 0;
    const previous = this.counters.get(key);
    this.counters.set(key, next);
    // A lower counter is a host that restarted; it starts again from there.
    return previous !== undefined && next > previous;
  }
}
