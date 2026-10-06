import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { VideoGeneration } from '@bike4mind/common';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { CREDITS_BALANCE_KEY } from '@client/app/hooks/data/credits';
import { isTerminalVideoState, patchVideoGeneration } from '@client/app/hooks/data/videoGenerationCache';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';

/**
 * Writes `generation_job_updated` frames for video jobs into the React Query cache, so every VideoJobCard (the
 * studio gallery, and the chat card in the agent-tool phase) is live without a subscription of its own.
 * A frame carries the stored error (internal code, possibly provider wording) and no signed URL, so only state
 * and progress are applied; a terminal frame refetches the job for its public error and output.
 * Mounted once, next to WebsocketReactQueryInvalidateListener (app/providers.tsx).
 */
const VideoGenerationUpdatesListener = () => {
  const { subscribeToAction, readyState } = useWebsocket();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToAction('generation_job_updated', async message => {
        if (message.action !== 'generation_job_updated' || message.job.kind !== 'video') return;
        const { id, state, progress } = message.job;
        const cached = patchVideoGeneration(queryClient, { id, state, progress });
        const pending: Promise<void>[] = [];
        // A job started on another surface (the API, the agent tool) while the gallery is open.
        if (!cached && queryClient.getQueryData(videoGenerationKeys.list)) {
          pending.push(queryClient.invalidateQueries({ queryKey: videoGenerationKeys.list }));
        }
        if (isTerminalVideoState(state)) {
          pending.push(queryClient.invalidateQueries({ queryKey: videoGenerationKeys.detail(id) }));
          pending.push(queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY }));
        }
        await Promise.all(pending);
      }),
    [queryClient, subscribeToAction]
  );

  // Frames sent while the socket was down are lost: catch up once per reconnect, never on the first connect.
  const hasOpenedRef = useRef(false);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = readyState === ReadyState.OPEN;
    if (isOpen && !wasOpenRef.current && hasOpenedRef.current) {
      void queryClient.invalidateQueries({ queryKey: videoGenerationKeys.list });
      for (const [key, job] of queryClient.getQueriesData<VideoGeneration>({ queryKey: videoGenerationKeys.details })) {
        if (job && !isTerminalVideoState(job.state)) {
          void queryClient.invalidateQueries({ queryKey: key, exact: true });
        }
      }
    }
    if (isOpen) hasOpenedRef.current = true;
    wasOpenRef.current = isOpen;
  }, [readyState, queryClient]);

  return null;
};

export default VideoGenerationUpdatesListener;
