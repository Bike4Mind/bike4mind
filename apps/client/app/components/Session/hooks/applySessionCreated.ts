import type { Dispatch, SetStateAction } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { updateAllQueryData } from '@client/app/utils/react-query';

export type ApplySessionCreatedDeps = {
  queryClient: QueryClient;
  migrateQuests: (tmpId: string, realId: string) => void;
  migrateSession: (tmpId: string, realId: string, realSession: ISessionDocument) => void;
  setCurrentSessionId: Dispatch<SetStateAction<string | null>>;
  setCurrentSession: Dispatch<SetStateAction<ISessionDocument | null>>;
  onSessionCreated?: (realId: string) => void;
  navigateToSession: (realId: string) => Promise<unknown>;
};

/**
 * Applies a `session.created` event (SessionContainer's subscription). The event fans out to
 * every tab of the user: each adds the session to its sidebar list, but only the tab whose /new
 * send minted it (pendingOptimisticId set) migrates the optimistic cache and switches to it.
 * Returns whether this tab minted it.
 */
export async function applySessionCreated(
  realSession: ISessionDocument,
  deps: ApplySessionCreatedDeps
): Promise<boolean> {
  const realId = realSession.id;
  // Read synchronously: the exact tmpId written at send time, not a possibly stale ref.
  const { pendingOptimisticId: tmpId } = useSessionLayout.getState();

  // Otherwise the list only learns of a session through the viewed session's own subscription.
  updateAllQueryData(deps.queryClient, 'sessions', 'write', realSession, {
    keysAllowedToCreate: [['sessions', 'own']],
  });

  // Every other creator - Data Lake, agent dispatch, the admin chat - adopts its own create
  // response, and a tab that created nothing must stay where it is. Merging into an
  // already-adopted copy of the same session (rather than replacing it) keeps fields the wire
  // copy lacks, e.g. the knowledgeIds a Data Lake session is born holding.
  if (!tmpId) {
    deps.setCurrentSession(prev => (prev && prev.id === realId ? { ...prev, ...realSession } : prev));
    return false;
  }

  // Recorded first so the stream gate adopts this session's frames (and only these) while the
  // view is still on the tmpId during the navigation below.
  setSessionLayout({ pendingRealSessionId: realId });

  if (tmpId !== realId) {
    deps.migrateQuests(tmpId, realId);
    deps.migrateSession(tmpId, realId, realSession);
  }

  deps.setCurrentSessionId(realId);
  deps.setCurrentSession(realSession);
  deps.onSessionCreated?.(realId);

  // replace: the tmpId never lands in the browser history stack.
  await deps.navigateToSession(realId);

  // Cleared only after navigation so the effectiveSessionId guard in SessionContainer
  // (pendingFirstMessage ? undefined : currentSessionId) never briefly exposes the tmpId to API
  // hooks. pendingFirstMessage itself is cleared by SessionMiddle once it has real data.
  setSessionLayout({ pendingOptimisticId: null, pendingRealSessionId: null });
  return true;
}
