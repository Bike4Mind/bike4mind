import { useEffect, useRef } from 'react';

import type { ISessionDocument } from '@bike4mind/common';

/**
 * Hydrate the model picker from a session's saved `lastUsedModel`, but only when a
 * *different* session is loaded -- keyed on the session id, not the `currentSession`
 * object identity.
 *
 * Keying on the object re-fired on every refetch and clobbered a model the user had
 * just picked (#958): the server rewrites `lastUsedModel` to the model that actually
 * ran, the session refetches with a new object identity, and the picker reverted --
 * a self-reinforcing loop that pinned users to the old model. Guarding on the id means
 * a refetch of the same session never overrides the user's in-session selection.
 */
export function useHydrateSessionModel(
  currentSession: Pick<ISessionDocument, 'id' | 'lastUsedModel'> | null,
  setModel: (model: string) => void
): void {
  const hydratedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const sessionId = currentSession?.id ?? null;
    if (sessionId === hydratedSessionIdRef.current) return;
    hydratedSessionIdRef.current = sessionId;
    if (currentSession?.lastUsedModel) {
      setModel(currentSession.lastUsedModel);
    }
  }, [currentSession, setModel]);
}
