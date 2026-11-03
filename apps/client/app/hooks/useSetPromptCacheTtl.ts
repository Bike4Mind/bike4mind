import { useCallback } from 'react';
import { toast } from 'sonner';
import type { PromptCacheTtl } from '@bike4mind/common';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';

/**
 * The composer's cache-lifetime choice for the current chat. Like useSetIncludeLibraryFiles:
 * optimistic on the cached session, one PUT carrying only the field, rolled back on failure.
 */
export default function useSetPromptCacheTtl() {
  const { currentSession, setCurrentSession } = useSessions();
  const { mutate: updateSession, isPending } = useUpdateSession();

  const setTtl = useCallback(
    (ttl: PromptCacheTtl) => {
      if (!currentSession || isPending || currentSession.promptCacheTtl === ttl) return;
      setCurrentSession({ ...currentSession, promptCacheTtl: ttl });
      updateSession(
        { id: currentSession.id, promptCacheTtl: ttl },
        {
          onError: () => {
            setCurrentSession(currentSession);
            toast.error('Could not change how long this chat stays cached - please try again.');
          },
        }
      );
    },
    [currentSession, isPending, setCurrentSession, updateSession]
  );

  return { chatTtl: currentSession?.promptCacheTtl, setTtl, isPending, hasSession: !!currentSession };
}
