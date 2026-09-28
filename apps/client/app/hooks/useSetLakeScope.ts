import { useCallback } from 'react';
import { toast } from 'sonner';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';

/**
 * Returns a setter that narrows the current chat's grounded retrieval to a chosen set of data
 * lakes, by writing `retrievalTags` on the session (#3042). Sibling of useSetDataLakeMode, which
 * flips retrieval on and off; this one says WHICH lakes it reaches once it is on.
 *
 * Takes lake TAGS (`datalakeTag`), not lake ids: tags are what the session stores and what the
 * search's `$in` clause matches, so converting at the boundary keeps the id->tag mapping in the
 * one place that has the lake list.
 *
 * An EMPTY set means "every lake I can reach" and is sent as `null`, the request spelling that
 * clears the choice - `[]` on the wire means the opposite ("no lake at all"), which no picker
 * state maps to. See SessionUpdateRequestSchema for the tri-state.
 *
 * Like useSetDataLakeMode: optimistic on the cached session, sends ONLY the changed field (a
 * whole-session echo would let a stale knowledgeIds overwrite another actor's removal), and rolls
 * back on failure so the picker never claims a scope the server refused.
 *
 * Wrapped in useCallback (matching useSetDataLakeMode) so the identity passed to a caller's own
 * memoized dep array (e.g. DataLakeExplorer's handleSelectLakes) is stable across renders.
 */
export default function useSetLakeScope() {
  const { currentSession, setCurrentSession } = useSessions();
  const { mutate: updateSession } = useUpdateSession();

  return useCallback(
    (lakeTags: string[]) => {
      if (!currentSession) return;
      const explicit = lakeTags.length > 0;
      setCurrentSession({ ...currentSession, retrievalTags: lakeTags, lakeScopeExplicit: explicit });
      updateSession(
        { id: currentSession.id, lakeScope: explicit ? lakeTags : null },
        {
          onError: () => {
            setCurrentSession(currentSession);
            toast.error('Could not update which data lakes this chat uses - please try again.');
          },
        }
      );
    },
    [currentSession, setCurrentSession, updateSession]
  );
}
