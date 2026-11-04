import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatHeldRelay } from '@shared/chat';

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
  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;

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
  }, [sessionId]);

  useEffect(
    () =>
      window.b4m.chat.onStreamEvent(event => {
        if (event.type === 'held-relays' && event.sessionId === activeSessionId.current) setHeld(event.held);
      }),
    []
  );

  const resolve = useCallback(
    async (heldId: string, deliver: boolean) => {
      if (!sessionId) return;
      await window.b4m.chat.resolveHeldRelay(sessionId, heldId, deliver);
    },
    [sessionId]
  );

  return { held, resolve };
}
