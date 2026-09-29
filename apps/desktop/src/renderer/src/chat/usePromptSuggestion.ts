import { useCallback, useEffect, useRef, useState } from 'react';
import { promptSuggestionsEnabled, usePromptSuggestions } from './promptSuggestions';

export interface PromptSuggestionController {
  /** The guess to draw as placeholder text, or null to use the ordinary placeholder. */
  suggestion: string | null;
  /**
   * Throw the current guess away. Called by the composer the moment the input stops being
   * empty, whether the user typed, pasted, or took the guess itself.
   */
  dismiss: () => void;
}

/**
 * Asks main for the message the user is most likely to send next, once per settled turn.
 *
 * Hung off the reply stream's own 'done' rather than a timer or a render: 'done' is the only
 * event that means the turn is finished AND the composer is free, and asking mid-stream would
 * guess from a reply that is still being written. 'start' clears whatever is showing, which
 * covers the case a `done` cannot - a queued message that begins the next turn immediately.
 *
 * Deliberately NOT part of useConversation, even though that hook owns the same stream: this is
 * a self-contained cosmetic feature with its own switch, and keeping it out means the composer,
 * the setting and this hook are the whole of it.
 */
export function usePromptSuggestion(sessionId: string | null): PromptSuggestionController {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  // Subscribed to rather than read, so turning the setting off clears a hint already on screen.
  const [enabled] = usePromptSuggestions();

  // Which session and which request the state belongs to, read inside callbacks that outlive
  // the render they were made in. `request` drops a late answer: the call takes a second or two,
  // and in that time the user can switch conversations or start another turn - and an answer
  // that arrives after either is a hint about a state that has gone.
  const activeSessionId = useRef<string | null>(sessionId);
  const request = useRef(0);

  useEffect(() => {
    activeSessionId.current = sessionId;
    request.current += 1;
    setSuggestion(null);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled) setSuggestion(null);
  }, [enabled]);

  useEffect(() => {
    return window.b4m.chat.onStreamEvent(event => {
      if (event.sessionId !== activeSessionId.current) return;

      // A new turn invalidates the last one's guess, and any call still in flight for it.
      if (event.type === 'start') {
        request.current += 1;
        setSuggestion(null);
        return;
      }

      // 'error' is excluded: a failed turn settles the composer too, but what follows one is a
      // retry the user words themselves, and guessing at it would be an odd thing to offer.
      if (event.type !== 'done') return;

      // Read at the moment of the call, not through the closure: a subscription made while the
      // setting was on must not keep spending after it is turned off.
      if (!promptSuggestionsEnabled()) return;

      const id = (request.current += 1);
      const forSession = event.sessionId;
      void window.b4m.chat
        .suggestNextPrompt(forSession)
        .then(next => {
          if (request.current !== id || activeSessionId.current !== forSession) return;
          setSuggestion(next);
        })
        // Main answers null for its own failures, so this only catches the channel itself
        // going away. Swallowed for the same reason: no hint is the whole of the fallback.
        .catch(() => undefined);
    });
    // Subscribed once. The setting is read live inside the handler instead of being a
    // dependency, so toggling it does not tear the stream subscription down and rebuild it.
  }, []);

  const dismiss = useCallback(() => {
    request.current += 1;
    setSuggestion(null);
  }, []);

  return { suggestion, dismiss };
}
