import { useCallback } from 'react';
import { toast } from 'sonner';
import { DATALAKE_TAG_PREFIX, effectiveIncludeLibraryFiles } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';

/**
 * The scope strip's My files chip: whether the current chat searches the caller's own and shared
 * files alongside its lakes, and a toggle for it. `included` is the EFFECTIVE value, so an unset
 * flag on a lake chat reads as off, the same way forced retrieval and the KB tools resolve it.
 *
 * Like useSetLakeScope: optimistic on the cached session, one PUT carrying only the flag, rolled
 * back on failure. `isPending` lets the chip refuse a second click, so two in-flight writes cannot
 * roll back out of order.
 */
export default function useSetIncludeLibraryFiles() {
  const { currentSession, setCurrentSession } = useSessions();
  const { mutate: updateSession, isPending } = useUpdateSession();

  const namesALake = !!currentSession?.retrievalTags?.some(tag => tag.startsWith(DATALAKE_TAG_PREFIX));
  const included = effectiveIncludeLibraryFiles(currentSession?.includeLibraryFiles, namesALake);

  const toggle = useCallback(() => {
    if (!currentSession || isPending) return;
    const next = !included;
    setCurrentSession({ ...currentSession, includeLibraryFiles: next });
    updateSession(
      { id: currentSession.id, includeLibraryFilesChoice: next },
      {
        onError: () => {
          setCurrentSession(currentSession);
          toast.error('Could not update whether this chat searches your files - please try again.');
        },
      }
    );
  }, [currentSession, included, isPending, setCurrentSession, updateSession]);

  return { included, toggle, isPending };
}
