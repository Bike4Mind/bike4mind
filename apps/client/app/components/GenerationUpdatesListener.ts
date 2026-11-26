import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { applyGenerationJobUpdate, refetchUnfinishedGenerationJobs } from '@client/app/hooks/data/generationJobs';

/**
 * Writes `generation_job_updated` frames into the React Query cache through the shared live-update path
 * (generationJobs.ts), so every job card (the Studio galleries and the chat cards) is live without a subscription of
 * its own. Mounted once, next to WebsocketReactQueryInvalidateListener (app/providers.tsx).
 */
const GenerationUpdatesListener = () => {
  const { subscribeToAction, readyState } = useWebsocket();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToAction('generation_job_updated', async message => {
        if (message.action !== 'generation_job_updated') return;
        await applyGenerationJobUpdate(queryClient, message.job);
      }),
    [queryClient, subscribeToAction]
  );

  // Frames sent while the socket was down are lost: catch up once per reconnect, never on the first connect.
  const hasOpenedRef = useRef(false);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = readyState === ReadyState.OPEN;
    if (isOpen && !wasOpenRef.current && hasOpenedRef.current) refetchUnfinishedGenerationJobs(queryClient);
    if (isOpen) hasOpenedRef.current = true;
    wasOpenRef.current = isOpen;
  }, [readyState, queryClient]);

  return null;
};

export default GenerationUpdatesListener;
