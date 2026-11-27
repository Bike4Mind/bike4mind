import { useCallback, useEffect, useState } from 'react';
import type {
  ChatSession,
  ChatSpawnSuggestion,
  SpawnSuggestionResult,
  StartSpawnSuggestionRequest,
} from '@shared/chat';
import { useSessionEvents } from '../host/useSessionEvents';

export interface SpawnSuggestionsController {
  /** Oldest first; the tray draws only the pending ones. */
  suggestions: ChatSpawnSuggestion[];
  start: (request: Omit<StartSpawnSuggestionRequest, 'sessionId'>) => Promise<SpawnSuggestionResult>;
  dismiss: (suggestionId: string) => Promise<SpawnSuggestionResult>;
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

  useEffect(() => {
    setSuggestions(loaded ?? []);
  }, [sessionId, loaded]);

  useSessionEvents(sessionId, {
    event: event => {
      if (event.type === 'spawn-suggestions') setSuggestions(event.suggestions);
    },
  });

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

  return { suggestions, start, dismiss };
}
