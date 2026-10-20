/**
 * Every write into a generation-job cache (a gallery list plus one detail entry per job). The list seed, the create
 * and cancel responses and the websocket listener all go through here so one set of ordering rules decides what may
 * overwrite what. Each kind builds its own instance (videoGenerationCache.ts, musicGenerationCache.ts).
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { GenerationJobState } from '@bike4mind/common';
import {
  isTerminalGenerationState,
  movesLiveStateBackwards,
  shouldReplaceGenerationJob,
  type PollableGenerationJob,
} from './generationJobPolling';

type CacheableJob = Pick<PollableGenerationJob, 'state' | 'updated_at'> & { id: string };

export type GenerationJobPage<TJob> = { data: TJob[]; next_cursor: string | null };
export type GenerationJobList<TJob> = InfiniteData<GenerationJobPage<TJob>, string | undefined>;
export type GenerationJobLiveUpdate = { id: string; state: GenerationJobState };

export type GenerationJobCacheKeys = {
  list: readonly unknown[];
  detail: (id: string) => readonly unknown[];
};

export type GenerationJobCache<TJob, TUpdate> = {
  /** Writes a job read as part of a list into its detail entry, unless the cache already holds something newer. */
  seed: (queryClient: QueryClient, job: TJob) => void;
  /**
   * Puts a just-created job at the top of the gallery, or refetches a gallery that has not loaded yet. A replayed
   * create (same Idempotency-Key) moves, not doubles.
   */
  prepend: (queryClient: QueryClient, job: TJob) => void;
  /**
   * Writes an authoritative server response (the cancel mutation) into the detail entry and its list row. A late
   * response never reverts a newer or terminal job; a job the cache has not seen at all is prepended like a create.
   */
  upsert: (queryClient: QueryClient, job: TJob) => void;
  /**
   * The value a detail query's own fetch should store. React Query writes a queryFn result without these ordering
   * rules, so a refetch read before a websocket frame (or the cancel response) landed would otherwise revert it - e.g.
   * a `running` snapshot replacing `succeeded`, which no later frame or poll corrects while the socket stays open.
   */
  reconcileFetched: (queryClient: QueryClient, job: TJob) => TJob;
  /** The page a list query's own fetch should store: each row reconciled as `reconcileFetched` does, then seeded. */
  reconcileFetchedPage: (queryClient: QueryClient, page: GenerationJobPage<TJob>) => GenerationJobPage<TJob>;
  /** Applies a websocket frame. Returns whether the job was cached anywhere. */
  patch: (queryClient: QueryClient, update: TUpdate) => boolean;
};

/**
 * `applyUpdate` merges a frame into a cached job; it only runs once the ordering rules allow the frame (a finished
 * job stays finished and a live one never steps back, since frames can arrive out of order).
 */
export function createGenerationJobCache<TJob extends CacheableJob, TUpdate extends GenerationJobLiveUpdate>(
  keys: GenerationJobCacheKeys,
  applyUpdate: (cached: TJob, update: TUpdate) => TJob
): GenerationJobCache<TJob, TUpdate> {
  const mapListedJobs = (queryClient: QueryClient, mapJob: (job: TJob) => TJob): void => {
    queryClient.setQueryData<GenerationJobList<TJob>>(
      keys.list,
      list => list && { ...list, pages: list.pages.map(page => ({ ...page, data: page.data.map(mapJob) })) }
    );
  };

  const seed = (queryClient: QueryClient, job: TJob): void => {
    const key = keys.detail(job.id);
    if (shouldReplaceGenerationJob(queryClient.getQueryData<TJob>(key), job)) {
      queryClient.setQueryData(key, job);
    }
  };

  const prepend = (queryClient: QueryClient, job: TJob): void => {
    seed(queryClient, job);
    // A list still loading was read before this job existed, and the job's frames then find its detail entry, so
    // nothing else would refresh the list: refetch it instead.
    if (!queryClient.getQueryData(keys.list)) {
      void queryClient.invalidateQueries({ queryKey: keys.list });
      return;
    }
    queryClient.setQueryData<GenerationJobList<TJob>>(keys.list, list => {
      if (!list || list.pages.length === 0) return list;
      const [first, ...rest] = list.pages;
      return {
        ...list,
        pages: [{ ...first, data: [job, ...first.data.filter(cached => cached.id !== job.id)] }, ...rest],
      };
    });
  };

  const upsert = (queryClient: QueryClient, job: TJob): void => {
    const detailKey = keys.detail(job.id);
    const cachedDetail = queryClient.getQueryData<TJob>(detailKey);
    const cachedList = queryClient.getQueryData<GenerationJobList<TJob>>(keys.list);
    const isListed = cachedList?.pages.some(page => page.data.some(cached => cached.id === job.id)) ?? false;

    if (!cachedDetail && !isListed) {
      prepend(queryClient, job);
      return;
    }
    if (shouldReplaceGenerationJob(cachedDetail, job)) {
      queryClient.setQueryData(detailKey, job);
    }
    mapListedJobs(queryClient, cached =>
      cached.id === job.id && shouldReplaceGenerationJob(cached, job) ? job : cached
    );
  };

  const findListed = (queryClient: QueryClient, id: string): TJob | undefined =>
    queryClient
      .getQueryData<GenerationJobList<TJob>>(keys.list)
      ?.pages.flatMap(page => page.data)
      .find(cached => cached.id === id);

  // A frame patches the list row even when the job has no detail entry, so the newest cached copy may be either one.
  const reconcileFetched = (queryClient: QueryClient, job: TJob): TJob => {
    const cached = [queryClient.getQueryData<TJob>(keys.detail(job.id)), findListed(queryClient, job.id)].reduce<
      TJob | undefined
    >(
      (newest, candidate) => (candidate && shouldReplaceGenerationJob(newest, candidate) ? candidate : newest),
      undefined
    );
    return cached && !shouldReplaceGenerationJob(cached, job) ? cached : job;
  };

  const reconcileFetchedPage = (queryClient: QueryClient, page: GenerationJobPage<TJob>): GenerationJobPage<TJob> => {
    const data = page.data.map(job => reconcileFetched(queryClient, job));
    data.forEach(job => seed(queryClient, job));
    return { ...page, data };
  };

  const patch = (queryClient: QueryClient, update: TUpdate): boolean => {
    let found = false;
    const patchJob = (cached: TJob): TJob => {
      if (cached.id !== update.id) return cached;
      found = true;
      if (isTerminalGenerationState(cached.state) || movesLiveStateBackwards(cached.state, update.state)) return cached;
      return applyUpdate(cached, update);
    };
    queryClient.setQueryData<TJob>(keys.detail(update.id), cached => cached && patchJob(cached));
    mapListedJobs(queryClient, patchJob);
    return found;
  };

  return { seed, prepend, upsert, reconcileFetched, reconcileFetchedPage, patch };
}
