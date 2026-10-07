import { useCallback } from 'react';
import { toast } from 'sonner';
import { effectiveIncludeLibraryFiles, libraryFlagForScope, retrievalTagsNameALake } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';

/**
 * The scope strip's My files chip: whether the current chat searches the caller's own and shared
 * files alongside its lakes, and a toggle for it. `included` is the EFFECTIVE value, so an unset
 * flag on a lake chat reads as off, the same way forced retrieval and the KB tools resolve it.
 *
 * Like useSetLakeScope: optimistic on the cached session, one PUT carrying only the flag, rolled
 * back on failure. `isPending` lets the chip refuse a second click, so two in-flight writes cannot
 * roll back out of order. `lakeFileTagPrefixes` are the caller's lakes' prefixes, so a prefix-named
 * lake reads as named here exactly as it does on the server (sessionNamesALake).
 */
export default function useSetIncludeLibraryFiles(lakeFileTagPrefixes: readonly (string | undefined)[] = []) {
  const { currentSession, setCurrentSession } = useSessions();
  const { mutate: updateSession, isPending } = useUpdateSession();

  const namesALake = retrievalTagsNameALake(currentSession?.retrievalTags, lakeFileTagPrefixes);
  const included = effectiveIncludeLibraryFiles(
    currentSession ? libraryFlagForScope(currentSession) : undefined,
    namesALake
  );

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
