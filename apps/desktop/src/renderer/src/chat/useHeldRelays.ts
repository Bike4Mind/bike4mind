import { useCallback, useEffect, useState } from 'react';
import type { ChatHeldRelay } from '@shared/chat';
import { useSessionEvents } from '../host/useSessionEvents';

export interface HeldRelaysController {
  held: ChatHeldRelay[];
  resolve: (heldId: string, deliver: boolean) => Promise<void>;
}

/**
 * The open conversation's held relays: read when it opens, then replaced by each 'held-relays'
 * push, which carries the whole list (like spawn suggestions).
 */
export function useHeldRelays(sessionId: string | null): HeldRelaysController {
  const [held, setHeld] = useState<ChatHeldRelay[]>([]);
  // Bumped by a resync, which may have skipped a push: the list is read again.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    setHeld([]);
    if (!sessionId) return;
    let stale = false;
    window.b4m.chat
      .getHeldRelays(sessionId)
      .then(list => {
        if (!stale) setHeld(list);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [sessionId, reads]);

  useSessionEvents(sessionId, {
    event: event => {
      if (event.type === 'held-relays') setHeld(event.held);
    },
    resync: () => setReads(count => count + 1),
  });

  const resolve = useCallback(
    async (heldId: string, deliver: boolean) => {
      if (!sessionId) return;
      await window.b4m.chat.resolveHeldRelay(sessionId, heldId, deliver);
    },
    [sessionId]
  );

  return { held, resolve };
}
