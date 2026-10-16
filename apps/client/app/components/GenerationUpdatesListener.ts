import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { IGenerationJobUpdatedAction, MusicGeneration, VideoGeneration } from '@bike4mind/common';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { CREDITS_BALANCE_KEY } from '@client/app/hooks/data/credits';
import { isAwaitingGenerationOutput, isTerminalGenerationState } from '@client/app/hooks/data/generationJobPolling';
import { patchMusicGeneration } from '@client/app/hooks/data/musicGenerationCache';
import { musicGenerationKeys } from '@client/app/hooks/data/musicGenerationKeys';
import { patchVideoGeneration } from '@client/app/hooks/data/videoGenerationCache';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';

type JobUpdate = IGenerationJobUpdatedAction['job'];

// 'all', not the default 'active': a card that is unmounted now (another notebook is open) skips its refetch on
// mount, so an invalidation that only marks it stale would leave it showing the old state when it comes back.
const refetchDetail = (queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> =>
  queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'all' });

const handleVideoUpdate = async (queryClient: QueryClient, { id, state, progress }: JobUpdate): Promise<void> => {
  const cached = patchVideoGeneration(queryClient, { id, state, progress });
  const pending: Promise<void>[] = [];
  // A job started on another surface (the API, the agent tool) while the gallery is open.
  if (!cached && queryClient.getQueryData(videoGenerationKeys.list)) {
    pending.push(queryClient.invalidateQueries({ queryKey: videoGenerationKeys.list }));
  }
  if (isTerminalGenerationState(state)) {
    pending.push(refetchDetail(queryClient, videoGenerationKeys.detail(id)));
    pending.push(queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY }));
  }
  await Promise.all(pending);
};

// No list cache for music yet: an uncached job is read by its own card when it mounts.
const handleMusicUpdate = async (queryClient: QueryClient, { id, state }: JobUpdate): Promise<void> => {
  patchMusicGeneration(queryClient, { id, state });
  if (!isTerminalGenerationState(state)) return;
  await Promise.all([
    refetchDetail(queryClient, musicGenerationKeys.detail(id)),
    queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY }),
  ]);
};

// Refetch the unfinished jobs and those still waiting for their output; a finished one needs nothing.
const invalidateUnfinishedDetails = (queryClient: QueryClient, detailsKey: readonly unknown[]): void => {
  for (const [key, job] of queryClient.getQueriesData<VideoGeneration | MusicGeneration>({ queryKey: detailsKey })) {
    if (job && (!isTerminalGenerationState(job.state) || isAwaitingGenerationOutput(job))) {
      void refetchDetail(queryClient, key);
    }
  }
};

/**
 * Writes `generation_job_updated` frames for video and music jobs into the React Query cache, so every job card (the
 * video studio gallery and the chat cards) is live without a subscription of its own.
 * A frame carries the stored error (internal code, possibly provider wording) and no signed URL, so only state
 * and progress are applied; a terminal frame refetches the job for its public error and output.
 * Mounted once, next to WebsocketReactQueryInvalidateListener (app/providers.tsx).
 */
const GenerationUpdatesListener = () => {
  const { subscribeToAction, readyState } = useWebsocket();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToAction('generation_job_updated', async message => {
        if (message.action !== 'generation_job_updated') return;
        if (message.job.kind === 'video') await handleVideoUpdate(queryClient, message.job);
        else if (message.job.kind === 'music') await handleMusicUpdate(queryClient, message.job);
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
      invalidateUnfinishedDetails(queryClient, videoGenerationKeys.details);
      invalidateUnfinishedDetails(queryClient, musicGenerationKeys.details);
    }
    if (isOpen) hasOpenedRef.current = true;
    wasOpenRef.current = isOpen;
  }, [readyState, queryClient]);

  return null;
};

export default GenerationUpdatesListener;
