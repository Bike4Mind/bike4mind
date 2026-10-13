import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatSession,
  ChatSpawnSuggestion,
  SpawnSuggestionResult,
  StartSpawnSuggestionRequest,
} from '@shared/chat';

export interface SpawnSuggestionsController {
  /** Pending cards and started rows the user has not closed, oldest first. */
  visible: ChatSpawnSuggestion[];
  start: (request: Omit<StartSpawnSuggestionRequest, 'sessionId'>) => Promise<SpawnSuggestionResult>;
  dismiss: (suggestionId: string) => Promise<SpawnSuggestionResult>;
  clear: (suggestionId: string) => void;
}

const NO_SESSION: SpawnSuggestionResult = { ok: false, error: 'No conversation is open.' };

/**
 * The open conversation's spawn suggestions: seeded from the session as it loads, then kept in
 * step by the 'spawn-suggestions' push, which carries the whole list each time.
 */
export function useSpawnSuggestions(session: ChatSession | null): SpawnSuggestionsController {
  const sessionId = session?.id ?? null;
  const loaded = session?.spawnSuggestions;
  const [suggestions, setSuggestions] = useState<ChatSpawnSuggestion[]>(loaded ?? []);

  const activeSessionId = useRef(sessionId);
  activeSessionId.current = sessionId;

  useEffect(() => {
    setSuggestions(loaded ?? []);
  }, [sessionId, loaded]);

  useEffect(
    () =>
      window.b4m.chat.onStreamEvent(event => {
        if (event.type === 'spawn-suggestions' && event.sessionId === activeSessionId.current) {
          setSuggestions(event.suggestions);
        }
      }),
    []
  );

  const start = useCallback(
    (request: Omit<StartSpawnSuggestionRequest, 'sessionId'>) =>
      sessionId ? window.b4m.chat.startSpawnSuggestion({ ...request, sessionId }) : Promise.resolve(NO_SESSION),
    [sessionId]
  );
  const dismiss = useCallback(
    (suggestionId: string) =>
      sessionId ? window.b4m.chat.dismissSpawnSuggestion(sessionId, suggestionId) : Promise.resolve(NO_SESSION),
    [sessionId]
  );
  const clear = useCallback(
    (suggestionId: string) => {
      if (sessionId) void window.b4m.chat.clearSpawnSuggestion(sessionId, suggestionId);
    },
    [sessionId]
  );

  const visible = suggestions.filter(
    entry => entry.status === 'pending' || (entry.status === 'started' && !entry.cleared)
  );
  return { visible, start, dismiss, clear };
}
