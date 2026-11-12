import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  GenerationJobKind,
  IGenerationJobUpdatedAction,
  MusicGeneration,
  VideoGeneration,
} from '@bike4mind/common';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { invalidateGenerationCreditBalances } from '@client/app/hooks/data/generationCreditBalances';
import { isAwaitingGenerationOutput, isTerminalGenerationState } from '@client/app/hooks/data/generationJobPolling';
import { patchMusicGeneration } from '@client/app/hooks/data/musicGenerationCache';
import { musicGenerationKeys } from '@client/app/hooks/data/musicGenerationKeys';
import { patchStudioImageJob, studioImageJobKeys } from '@client/app/hooks/data/studioImageJobs';
import { patchVideoGeneration } from '@client/app/hooks/data/videoGenerationCache';
import { videoGenerationKeys } from '@client/app/hooks/data/videoGenerationKeys';

type JobUpdate = IGenerationJobUpdatedAction['job'];

// 'all', not the default 'active': a card that is unmounted now (another notebook is open) skips its refetch on
// mount, so an invalidation that only marks it stale would leave it showing the old state when it comes back.
const refetchDetail = (queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> =>
  queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'all' });

type KindCache = {
  keys: { list: readonly unknown[]; details: readonly unknown[]; detail: (id: string) => readonly unknown[] };
  // Applies the frame to the cache; returns whether the job was cached anywhere.
  patch: (queryClient: QueryClient, job: JobUpdate) => boolean;
};

// Image jobs have no per-job cache: Studio's gallery list is the only one (handleImageUpdate).
type CachedKind = Exclude<GenerationJobKind, 'image'>;

const KIND_CACHES: Record<CachedKind, KindCache> = {
  video: {
    keys: videoGenerationKeys,
    patch: (queryClient, { id, state, progress }) => patchVideoGeneration(queryClient, { id, state, progress }),
  },
  music: {
    keys: musicGenerationKeys,
    patch: (queryClient, { id, state }) => patchMusicGeneration(queryClient, { id, state }),
  },
};

// A server newer than this client can send a kind it has no cache for.
const isCachedKind = (kind: string): kind is CachedKind => Object.hasOwn(KIND_CACHES, kind);

// The frame moves the gallery row's state; a finished job refetches the list, which carries its output file and
// public error. Nothing to do when the gallery has never loaded.
const handleImageUpdate = async (queryClient: QueryClient, job: JobUpdate): Promise<void> => {
  const isTerminal = isTerminalGenerationState(job.state);
  const cached = patchStudioImageJob(queryClient, job);
  const pending: Promise<void>[] = [];
  if ((isTerminal || !cached) && queryClient.getQueryData(studioImageJobKeys.list)) {
    pending.push(queryClient.invalidateQueries({ queryKey: studioImageJobKeys.list }));
  }
  if (isTerminal) pending.push(invalidateGenerationCreditBalances(queryClient));
  await Promise.all(pending);
};

const handleUpdate = async (queryClient: QueryClient, job: JobUpdate): Promise<void> => {
  if (job.kind === 'image') {
    await handleImageUpdate(queryClient, job);
    return;
  }
  if (!isCachedKind(job.kind)) {
    if (isTerminalGenerationState(job.state)) await invalidateGenerationCreditBalances(queryClient);
    return;
  }
  const { keys, patch } = KIND_CACHES[job.kind];
  const cached = patch(queryClient, job);
  const pending: Promise<void>[] = [];
  // A job started on another surface (the API, the chat tool) while the gallery is open.
  if (!cached && queryClient.getQueryData(keys.list)) {
    pending.push(queryClient.invalidateQueries({ queryKey: keys.list }));
  }
  if (isTerminalGenerationState(job.state)) {
    pending.push(refetchDetail(queryClient, keys.detail(job.id)));
    pending.push(invalidateGenerationCreditBalances(queryClient));
  }
  await Promise.all(pending);
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
 * Writes `generation_job_updated` frames for video, music and Studio image jobs into the React Query cache, so every job card (the
 * Studio galleries and the chat cards) is live without a subscription of its own.
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
        await handleUpdate(queryClient, message.job);
      }),
    [queryClient, subscribeToAction]
  );

  // Frames sent while the socket was down are lost: catch up once per reconnect, never on the first connect.
  const hasOpenedRef = useRef(false);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const isOpen = readyState === ReadyState.OPEN;
    if (isOpen && !wasOpenRef.current && hasOpenedRef.current) {
      for (const { keys } of Object.values(KIND_CACHES)) {
        void queryClient.invalidateQueries({ queryKey: keys.list });
        invalidateUnfinishedDetails(queryClient, keys.details);
      }
      void queryClient.invalidateQueries({ queryKey: studioImageJobKeys.list });
    }
    if (isOpen) hasOpenedRef.current = true;
    wasOpenRef.current = isOpen;
  }, [readyState, queryClient]);

  return null;
};

export default GenerationUpdatesListener;
