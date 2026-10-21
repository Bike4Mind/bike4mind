import { useEffect, useRef } from 'react';
import type { ISessionDocument } from '@bike4mind/common';

/**
 * Hydrates the model picker from a session's pinned `lastUsedModel` -- exactly ONCE per
 * session, unless the user already selected a model while its document was loading.
 *
 * The "once" is the whole point. This used to be a plain effect keyed on the session object:
 *
 *   useEffect(() => {
 *     if (currentSession?.lastUsedModel) setLLM({ model: currentSession.lastUsedModel });
 *   }, [currentSession, setLLM]);
 *
 * `currentSession` is React state that gets a FRESH OBJECT IDENTITY on every optimistic
 * update -- most importantly the `lastUpdated`/`updatedAt` bump that SessionsContext applies
 * in the message-send path. That new object still carries the OLD `lastUsedModel`, because
 * persisting a model change is a separate fire-and-forget PUT that has usually not landed yet.
 *
 * So picking a new model and hitting send went: user selects B -> send bumps the timestamp ->
 * effect re-fires with the stale object -> picker snaps back to A -> the turn runs on A.
 * Users could not change models at all, and the reverted-to model was billed. Worse, the
 * server writes `lastUsedModel` from the model that actually RAN, so A got re-pinned and the
 * revert became self-reinforcing.
 *
 * Tracking the hydrated session id in a ref (rather than narrowing the dep array) keeps the
 * effect honest about what it reads while making the body idempotent. It also handles a
 * session object that arrives before its `lastUsedModel` does: no hydration is recorded until
 * a model is actually applied, so a later arrival still hydrates.
 *
 * @param currentSession the active session, or null when none is loaded
 * @param applyModel called with the model id to select; must be referentially stable
 */
export function useHydrateModelFromSession(
  currentSession: (Pick<ISessionDocument, 'id' | 'lastUsedModel'> & { isOptimistic?: boolean }) | null | undefined,
  applyModel: (model: string) => void,
  restorePreferredModel?: () => void,
  hasExplicitModelSelection?: () => boolean
): void {
  // Session id this hook has already hydrated. Survives re-renders; never triggers one.
  const hydratedSessionIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeSessionIsOptimisticRef = useRef(false);

  useEffect(() => {
    const sessionId = currentSession?.id ?? null;
    if (activeSessionIdRef.current !== sessionId) {
      // null -> id is also the first send creating a chat. Keep its pre-send selection.
      // Replacing an optimistic id with the server id is still that same chat.
      const adoptingCreatedSession = activeSessionIsOptimisticRef.current && sessionId !== null;
      if (!adoptingCreatedSession && (activeSessionIdRef.current !== null || currentSession?.lastUsedModel)) {
        restorePreferredModel?.();
      }
      activeSessionIdRef.current = sessionId;
      activeSessionIsOptimisticRef.current = currentSession?.isOptimistic ?? false;
      hydratedSessionIdRef.current = null;
    }
    if (!sessionId) {
      // Session closed/cleared: allow a future re-open to hydrate again.
      hydratedSessionIdRef.current = null;
      return;
    }

    if (hydratedSessionIdRef.current === sessionId) return;

    if (hasExplicitModelSelection?.()) {
      hydratedSessionIdRef.current = sessionId;
      return;
    }

    const pinnedModel = currentSession?.lastUsedModel;
    if (!pinnedModel) return; // Not hydrated yet -- stay eligible for a later arrival.

    hydratedSessionIdRef.current = sessionId;
    applyModel(pinnedModel);
  }, [currentSession, applyModel, restorePreferredModel, hasExplicitModelSelection]);
}
