import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ISessionDocument } from '@bike4mind/common';
import { useChatInput } from '@client/app/hooks/useChatInput';

/**
 * Single source of truth for migrating React Query cache entries from the
 * client-generated optimistic session id (`tmpId`) to the real server-assigned
 * id (`realId`).
 *
 * When a message is sent from `/new`, `useSendMessage` seeds the cache under a
 * synthetic `tmpId` and navigates immediately (optimistic pre-navigation). Once
 * the backend creates the real session, the cached data must be moved to the
 * real id so the UI doesn't flash empty when the URL flips. Two paths can drive
 * that move:
 *   1. `session.created` WebSocket message (primary) - handled in SessionContainer.
 *   2. The send API response (fallback, when the WS was missed) - handled in useSendMessage.
 *
 * Both paths previously inlined character-identical cache shuffling. This hook
 * owns the cache-key movement plus the one piece of tmpId-scoped cleanup that
 * both paths would otherwise duplicate (the leftover empty draft); callers keep
 * their own navigation, Zustand, and setCurrentSession orchestration, which
 * legitimately differs between the two paths.
 *
 * The migration is idempotent in effect, so it is safe if both paths fire: a
 * second `migrateQuests` finds the tmp quest cache already gone and no-ops, a
 * second `migrateSession` simply re-writes `['sessions', realId]` with the same
 * server document and its `clearDraft(tmpId)` no-ops once the key is gone. (In
 * practice the callers also guard on the pending optimistic id, so the second
 * path is usually gated out before it calls in.)
 *
 * Cache keys owned here:
 *   - `['quests', 'session', id]` - paginated quest list for a session
 *   - `['sessions', id]`          - the session document
 *
 * Also clears the persisted `drafts[tmpId]` entry (useChatInput / localStorage)
 * in `migrateSession`, since that draft's lifecycle ends with the tmpId.
 */
export type UseSessionCacheMigrationReturn = {
  /** Move the paginated quest list from tmpId -> realId. No-op if no tmp data exists. */
  migrateQuests: (tmpId: string, realId: string) => void;
  /** Write the real session document under realId, drop the synthetic tmp cache entry, and clear the empty tmpId draft. */
  migrateSession: (tmpId: string, realId: string, realSession: ISessionDocument) => void;
  /** Remove all optimistic cache entries for a tmpId (used when the new session is rolled back). */
  cleanupOptimistic: (tmpId: string) => void;
};

export function useSessionCacheMigration(): UseSessionCacheMigrationReturn {
  const queryClient = useQueryClient();

  const migrateQuests = useCallback(
    (tmpId: string, realId: string) => {
      // Move quests cache so SessionMiddle doesn't flash empty when the URL updates.
      const tmpQuestsData = queryClient.getQueryData(['quests', 'session', tmpId]);
      if (tmpQuestsData) {
        queryClient.setQueryData(['quests', 'session', realId], tmpQuestsData);
        queryClient.removeQueries({ queryKey: ['quests', 'session', tmpId] });
      }
    },
    [queryClient]
  );

  const migrateSession = useCallback(
    (tmpId: string, realId: string, realSession: ISessionDocument) => {
      // Replace the synthetic session cache entry with real server data.
      queryClient.setQueryData(['sessions', realId], realSession);
      queryClient.removeQueries({ queryKey: ['sessions', tmpId] });
      // Drop the empty `optimistic-session-<uuid>: ''` draft the composer's
      // onChange left behind while currentSessionId was still the tmpId - it's
      // harmless cruft, but without this it accumulates in the persisted drafts
      // map. Cleared here (rather than at send) so both resolve paths - the
      // session.created WS message and the send-response fallback - cover it.
      useChatInput.getState().clearDraft(tmpId);
    },
    [queryClient]
  );

  const cleanupOptimistic = useCallback(
    (tmpId: string) => {
      queryClient.removeQueries({ queryKey: ['sessions', tmpId] });
      queryClient.removeQueries({ queryKey: ['quests', 'session', tmpId] });
    },
    [queryClient]
  );

  return { migrateQuests, migrateSession, cleanupOptimistic };
}
