import { useEffect, useRef, useState } from 'react';
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
  // Bumped by a resync. A turn may have settled unheard, and an idle session is not in
  // session/statuses, so a resync counts as one; the counters are then read again.
  const [reads, setReads] = useState(0);
  useHostResync(() => {
    setReads(count => count + 1);
    setSettled(count => count + 1);
  });
  const counters = useRef(new SettledTurnCounters());

  useEffect(() => {
    let live = true;
    const seen = counters.current;
    const off = hostClient.onNotification('session/statusChanged', ({ event }, hostId) => {
      if (seen.observe(hostId, event)) setSettled(count => count + 1);
    });
    for (const hostId of servingHosts) {
      void hostClient
        .request(hostId, 'session/statuses')
        .then(({ statuses }) => {
          if (!live) return;
          for (const event of statuses) seen.observe(hostId, event);
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
      off();
    };
  }, [reads, servingHosts]);

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
