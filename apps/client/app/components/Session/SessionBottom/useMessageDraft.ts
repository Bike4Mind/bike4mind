import { useEffect, useRef } from 'react';

import { useChatInput, NEW_NOTEBOOK_DRAFT_KEY } from '@client/app/hooks/useChatInput';

/**
 * Persists the chat input draft per session.
 * - When the session changes, saves the current input as a draft for the previous session.
 * - Restores the draft (or an empty string) for the incoming session.
 * - A brand-new notebook (null id) drafts under NEW_NOTEBOOK_DRAFT_KEY so its text
 *   survives a full-page reload; the draft is cleared once the notebook resolves to
 *   a real id (its text is not carried forward - see the null->id branch below).
 */
export function useMessageDraft(
  currentSessionId: string | null,
  setChatInputValue: (value: string) => void,
  setDraft: (sessionId: string, value: string) => void,
  getDraft: (sessionId: string) => string,
  clearDraft: (sessionId: string) => void
): void {
  // undefined = never run yet; distinguishes the first mount from a genuine null session.
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    const currentKey = currentSessionId ?? NEW_NOTEBOOK_DRAFT_KEY;

    // First mount: restore the saved draft for this session (or the new-notebook draft).
    if (prevSessionId === undefined) {
      const restored = getDraft(currentKey);
      if (restored) {
        setChatInputValue(restored);
      }
      prevSessionIdRef.current = currentSessionId;
      return;
    }

    if (prevSessionId === currentSessionId) return;

    // Leaving a new notebook (null) for a real id - either it resolved after the
    // first send (text already consumed) or the user navigated to another notebook.
    // Both cases: restore the target's own draft and drop the shared new-notebook
    // key so its text can't leak into an unrelated session. (Not carried forward:
    // null->id is ambiguous between "same notebook resolved" and "switched away".)
    if (prevSessionId === null && currentSessionId) {
      setChatInputValue(getDraft(currentSessionId));
      clearDraft(NEW_NOTEBOOK_DRAFT_KEY);
      prevSessionIdRef.current = currentSessionId;
      return;
    }

    // Normal session switch: save the outgoing session's text, restore the incoming one's.
    const prevKey = prevSessionId ?? NEW_NOTEBOOK_DRAFT_KEY;
    const currentValue = useChatInput.getState().chatInputValue;
    if (currentValue) {
      setDraft(prevKey, currentValue);
    }
    setChatInputValue(getDraft(currentKey));
    prevSessionIdRef.current = currentSessionId;
  }, [currentSessionId, setChatInputValue, setDraft, getDraft, clearDraft]);
}
