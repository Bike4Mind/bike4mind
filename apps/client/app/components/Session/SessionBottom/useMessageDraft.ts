import { useEffect, useRef } from 'react';

import { useChatInput } from '@client/app/hooks/useChatInput';

/**
 * Persists the chat input draft per session.
 * - When the session changes, saves the current input as a draft for the previous session.
 * - Restores the draft (or an empty string) for the incoming session.
 */
export function useMessageDraft(
  currentSessionId: string | null,
  setChatInputValue: (value: string) => void,
  setDraft: (sessionId: string, value: string) => void,
  getDraft: (sessionId: string) => string
): void {
  const prevSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!currentSessionId) return;

    const prevSessionId = prevSessionIdRef.current;

    if (prevSessionId && prevSessionId !== currentSessionId) {
      const currentValue = useChatInput.getState().chatInputValue;
      if (currentValue) {
        setDraft(prevSessionId, currentValue);
      }
    }

    setChatInputValue(getDraft(currentSessionId));
    prevSessionIdRef.current = currentSessionId;
  }, [currentSessionId, setChatInputValue, setDraft, getDraft]);
}
