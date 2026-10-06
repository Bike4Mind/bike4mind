/**
 * Every write into the video-generation cache. The list seed, the create and cancel responses and the websocket
 * listener all go through here so one set of ordering rules decides what may overwrite what.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { TERMINAL_GENERATION_JOB_STATES, type GenerationJobState, type VideoGeneration } from '@bike4mind/common';
import { videoGenerationKeys } from './videoGenerationKeys';

export type VideoGenerationPage = { data: VideoGeneration[]; next_cursor: string | null };
export type VideoGenerationList = InfiniteData<VideoGenerationPage, string | undefined>;
export type VideoJobLiveUpdate = { id: string; state: GenerationJobState; progress?: number };

export const isTerminalVideoState = (state: GenerationJobState): boolean =>
  TERMINAL_GENERATION_JOB_STATES.includes(state);

// A terminal job is final, and a snapshot read earlier (a list request that was in flight while a detail
// refetch landed) must not replace a later one.
export const shouldReplaceVideoGeneration = (
  existing: VideoGeneration | undefined,
  incoming: VideoGeneration
): boolean => {
  if (!existing) return true;
  if (isTerminalVideoState(existing.state) && !isTerminalVideoState(incoming.state)) return false;
  return Date.parse(incoming.updated_at) >= Date.parse(existing.updated_at);
};

const mapListedJobs = (queryClient: QueryClient, mapJob: (job: VideoGeneration) => VideoGeneration): void => {
  queryClient.setQueryData<VideoGenerationList>(
    videoGenerationKeys.list,
    list => list && { ...list, pages: list.pages.map(page => ({ ...page, data: page.data.map(mapJob) })) }
  );
};

/** Writes a job read as part of a list into its detail entry, unless the cache already holds something newer. */
export function seedVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void {
  const key = videoGenerationKeys.detail(job.id);
  if (shouldReplaceVideoGeneration(queryClient.getQueryData<VideoGeneration>(key), job)) {
    queryClient.setQueryData(key, job);
  }
}

/** Puts a just-created job at the top of the gallery. A replayed create (same Idempotency-Key) moves, not doubles. */
export function prependVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void {
  queryClient.setQueryData(videoGenerationKeys.detail(job.id), job);
  queryClient.setQueryData<VideoGenerationList>(videoGenerationKeys.list, list => {
    if (!list || list.pages.length === 0) return list;
    const [first, ...rest] = list.pages;
    return {
      ...list,
      pages: [{ ...first, data: [job, ...first.data.filter(cached => cached.id !== job.id)] }, ...rest],
    };
  });
}

/**
 * Writes an authoritative server response (the cancel mutation) into the detail entry and its list row. Both writes obey
 * shouldReplaceVideoGeneration, so a late response never reverts a newer or terminal job. A job the cache has not
 * seen at all is prepended like a new create.
 */
export function upsertVideoGeneration(queryClient: QueryClient, job: VideoGeneration): void {
  const detailKey = videoGenerationKeys.detail(job.id);
  const cachedDetail = queryClient.getQueryData<VideoGeneration>(detailKey);
  const cachedList = queryClient.getQueryData<VideoGenerationList>(videoGenerationKeys.list);
  const isListed = cachedList?.pages.some(page => page.data.some(cached => cached.id === job.id)) ?? false;

  if (!cachedDetail && !isListed) {
    prependVideoGeneration(queryClient, job);
    return;
  }
  if (shouldReplaceVideoGeneration(cachedDetail, job)) {
    queryClient.setQueryData(detailKey, job);
  }
  mapListedJobs(queryClient, cached =>
    cached.id === job.id && shouldReplaceVideoGeneration(cached, job) ? job : cached
  );
}

/** Applies a websocket frame's state and progress. Returns whether the job was cached anywhere. */
export function patchVideoGeneration(queryClient: QueryClient, update: VideoJobLiveUpdate): boolean {
  let found = false;
  // The patch keeps the cached updated_at, so an older list row sharing that timestamp can briefly move storing back
  // to running until the next frame (terminal jobs stay protected).
  const patch = (cached: VideoGeneration): VideoGeneration => {
    if (cached.id !== update.id) return cached;
    found = true;
    // Frames can arrive out of order; a finished job stays finished.
    if (isTerminalVideoState(cached.state)) return cached;
    return { ...cached, state: update.state, progress: update.progress ?? cached.progress };
  };
  queryClient.setQueryData<VideoGeneration>(videoGenerationKeys.detail(update.id), cached => cached && patch(cached));
  mapListedJobs(queryClient, patch);
  return found;
}
