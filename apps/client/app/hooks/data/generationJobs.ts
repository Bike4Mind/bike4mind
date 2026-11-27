/**
 * The one read path for generation jobs: `useGenerationJobs(kind)` (a Studio gallery), `useGenerationJob(kind, id)` (one
 * job card) and the live-update path GenerationUpdatesListener drives (`applyGenerationJobUpdate`,
 * `refetchUnfinishedGenerationJobs`). What differs per kind (routes, cache keys, ordering rules, retry and polling)
 * lives in GENERATION_JOB_SOURCES; create, cancel and model hooks stay with each kind (videoGenerations.ts,
 * musicGenerations.ts, studioImageJobs.ts).
 *
 * Speech and sound effects answer inline and keep no job read route, and Scenes (compose) have no web job cache yet,
 * so their frames only refresh the credit balance. Render jobs live in the Productions export panel (studioRenders.ts).
 */
import { isAxiosError } from 'axios';
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient, type QueryState } from '@tanstack/react-query';
import type {
  GenerationJobKind,
  IGenerationJobUpdatedAction,
  MusicGeneration,
  VideoGeneration,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { fabFileKeys } from './fabFileKeys';
import { hasGenerationCreditSettlementChanged, invalidateGenerationCreditBalances } from './generationCreditBalances';
import type { GenerationJobCache, GenerationJobList, GenerationJobPage } from './generationJobCache';
import {
  SOCKET_DOWN_POLL_MS,
  generationJobPollInterval,
  generationListRefreshInterval,
  isAwaitingGenerationOutput,
  isTerminalGenerationState,
  shouldReplaceGenerationJob,
  type PollableGenerationJob,
} from './generationJobPolling';
import {
  ERRORED_RELOAD_MS,
  MAX_ERRORED_RELOADS,
  chatImageJobKeys,
  imageJobRetryDelay,
  patchChatImageJob,
  shouldRetryImageJob,
  type ChatImageJob,
} from './imageJobs';
import { musicGenerationCache } from './musicGenerationCache';
import { musicGenerationKeys } from './musicGenerationKeys';
import {
  patchStudioImageJob,
  shouldPollStudioImageJobs,
  studioImageJobKeys,
  type StudioImageJob,
} from './studioImageJobs';
import { studioRenderKeys } from './studioRenders';
import { videoGenerationCache } from './videoGenerationCache';
import { videoGenerationKeys } from './videoGenerationKeys';

export type ReadableGenerationJobKind = Extract<GenerationJobKind, 'video' | 'music' | 'image'>;

/** A gallery row per kind. Image's gallery is Studio's own route, so its rows differ from the chat card's job. */
export type ListedGenerationJob = { video: VideoGeneration; music: MusicGeneration; image: StudioImageJob };
export type GenerationJob = { video: VideoGeneration; music: MusicGeneration; image: ChatImageJob };

export const GENERATION_GALLERY_PAGE_SIZE = 12;

type JobUpdate = IGenerationJobUpdatedAction['job'];

type ListSource<TJob> = {
  key: readonly unknown[];
  url: string;
  /** The page the list query stores for a fetched one. */
  storePage: (queryClient: QueryClient, page: GenerationJobPage<TJob>) => GenerationJobPage<TJob>;
  refetchInterval: (list: GenerationJobList<TJob> | undefined, socketOpen: boolean, now: number) => number | false;
};

type DetailSource<TJob> = {
  details: readonly unknown[];
  key: (id: string) => readonly unknown[];
  url: (id: string) => string;
  /** The job the detail query stores for a fetched one, given what the cache held before the read. */
  storeFetched: (queryClient: QueryClient, previous: TJob | undefined, fetched: TJob) => TJob;
  refetchOnMount: boolean;
  refetchInterval: (
    state: Pick<QueryState<TJob, unknown>, 'data' | 'error' | 'errorUpdateCount'>,
    socketOpen: boolean,
    now: number
  ) => number | false;
  retry: (failureCount: number, error: unknown) => boolean;
  retryDelay?: (failureCount: number) => number;
};

type LiveSource = {
  /** Applies a frame's state (and progress) to every cached copy. Returns whether a loaded gallery page holds it. */
  patch: (queryClient: QueryClient, update: JobUpdate) => boolean;
  /** The gallery row, not a detail entry, carries the output, so a finished job refetches the gallery. */
  refetchListOnTerminal: boolean;
};

type GenerationJobSource<TListed, TJob> = { list: ListSource<TListed>; detail: DetailSource<TJob>; live: LiveSource };

const statusOf = (error: unknown): number | undefined => (isAxiosError(error) ? error.response?.status : undefined);

const retryUnlessMissingOrLimited = (failureCount: number, error: unknown): boolean => {
  const status = statusOf(error);
  return status !== 404 && status !== 429 && failureCount < 3;
};

const refreshCreditsIfSettled = (
  queryClient: QueryClient,
  previous: PollableGenerationJob | undefined,
  job: PollableGenerationJob
) => {
  if (hasGenerationCreditSettlementChanged(previous, job)) void invalidateGenerationCreditBalances(queryClient);
};

/** Video and music share a job shape: a list and per-id detail entries, kept in order by generationJobCache.ts. */
function jobCacheSource<TJob extends VideoGeneration | MusicGeneration>(
  keys: typeof videoGenerationKeys | typeof musicGenerationKeys,
  url: string,
  cache: GenerationJobCache<TJob, JobUpdate>,
  afterDetailFetch?: (queryClient: QueryClient, previous: TJob | undefined, job: TJob) => void
): GenerationJobSource<TJob, TJob> {
  return {
    list: {
      key: keys.list,
      url,
      storePage: (queryClient, page) => {
        const previousJobs = new Map(
          page.data.map(job => [job.id, queryClient.getQueryData<TJob>(keys.detail(job.id))])
        );
        const stored = cache.reconcileFetchedPage(queryClient, page);
        if (stored.data.some(job => hasGenerationCreditSettlementChanged(previousJobs.get(job.id), job))) {
          void invalidateGenerationCreditBalances(queryClient);
        }
        return stored;
      },
      refetchInterval: (list, _socketOpen, now) => generationListRefreshInterval(list, now),
    },
    detail: {
      details: keys.details,
      key: keys.detail,
      url: id => `${url}/${encodeURIComponent(id)}`,
      storeFetched: (queryClient, previous, fetched) => {
        const job = cache.reconcileFetched(queryClient, fetched);
        refreshCreditsIfSettled(queryClient, previous, job);
        afterDetailFetch?.(queryClient, previous, job);
        return job;
      },
      // The list refetch re-seeds detail entries; an uncached card has no data and still fetches on mount.
      refetchOnMount: false,
      refetchInterval: ({ data }, socketOpen, now) => generationJobPollInterval(data, socketOpen, now),
      retry: retryUnlessMissingOrLimited,
    },
    live: {
      patch: (queryClient, update) => {
        const isListed = cache.isListed(queryClient, update.id);
        cache.patch(queryClient, update);
        return isListed;
      },
      refetchListOnTerminal: false,
    },
  };
}

const imageSource: GenerationJobSource<StudioImageJob, ChatImageJob> = {
  // The Studio route has no per-job read, so its gallery list is the only cache for Studio jobs.
  list: {
    key: studioImageJobKeys.list,
    url: '/api/studio/image-jobs',
    storePage: (_queryClient, page) => page,
    refetchInterval: (list, socketOpen) => (shouldPollStudioImageJobs(socketOpen, list) ? SOCKET_DOWN_POLL_MS : false),
  },
  // The chat card: one job a chat tool call started.
  detail: {
    details: chatImageJobKeys.details,
    key: chatImageJobKeys.detail,
    url: id => `/api/image-jobs/${encodeURIComponent(id)}`,
    storeFetched: (queryClient, previous, job) => {
      refreshCreditsIfSettled(queryClient, previous, job);
      // A read taken before a websocket frame landed must not step the cached state back.
      return previous && !shouldReplaceGenerationJob(previous, job) ? previous : job;
    },
    refetchOnMount: true,
    refetchInterval: ({ data, error, errorUpdateCount }, socketOpen, now) => {
      if (!data && error) {
        return statusOf(error) !== 404 && errorUpdateCount < MAX_ERRORED_RELOADS ? ERRORED_RELOAD_MS : false;
      }
      return generationJobPollInterval(data, socketOpen, now);
    },
    retry: shouldRetryImageJob,
    retryDelay: imageJobRetryDelay,
  },
  live: {
    patch: (queryClient, update) => {
      patchChatImageJob(queryClient, update);
      return patchStudioImageJob(queryClient, update);
    },
    refetchListOnTerminal: true,
  },
};

const GENERATION_JOB_SOURCES: {
  [K in ReadableGenerationJobKind]: GenerationJobSource<ListedGenerationJob[K], GenerationJob[K]>;
} = {
  video: jobCacheSource<VideoGeneration>(videoGenerationKeys, '/api/v1/video-generations', videoGenerationCache),
  music: jobCacheSource<MusicGeneration>(
    musicGenerationKeys,
    '/api/v1/music-generations',
    musicGenerationCache,
    (queryClient, previous, job) => {
      // The song's file is saved after the chat turn ended, past the one-shot session-files refresh that follows
      // it (useSubscribeChatCompletion), so refresh the file lists once the file first shows up.
      if (previous && !previous.output?.file_id && job.output?.file_id) {
        void queryClient.invalidateQueries({ queryKey: fabFileKeys.own });
      }
    }
  ),
  image: imageSource,
};

const isReadableKind = (kind: string): kind is ReadableGenerationJobKind => Object.hasOwn(GENERATION_JOB_SOURCES, kind);

/** A Studio gallery: the caller's jobs of one kind, newest first, from every source (Studio, chat, API). */
export function useGenerationJobs<K extends ReadableGenerationJobKind>(kind: K) {
  const { list } = GENERATION_JOB_SOURCES[kind];
  const { readyState } = useWebsocket();
  const queryClient = useQueryClient();
  const socketOpen = readyState === ReadyState.OPEN;
  return useInfiniteQuery({
    queryKey: list.key,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<GenerationJobPage<ListedGenerationJob[K]>>(list.url, {
        params: { limit: GENERATION_GALLERY_PAGE_SIZE, ...(pageParam && { cursor: pageParam }) },
      });
      return list.storePage(queryClient, response.data);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    refetchInterval: query => list.refetchInterval(query.state.data, socketOpen, Date.now()),
  });
}

/** One job card. Live updates arrive over the websocket (GenerationUpdatesListener); polling is the fallback. */
export function useGenerationJob<K extends ReadableGenerationJobKind>(kind: K, jobId: string) {
  const { detail } = GENERATION_JOB_SOURCES[kind];
  const { readyState } = useWebsocket();
  const queryClient = useQueryClient();
  const socketOpen = readyState === ReadyState.OPEN;
  return useQuery({
    queryKey: detail.key(jobId),
    queryFn: async () => {
      const previous = queryClient.getQueryData<GenerationJob[K]>(detail.key(jobId));
      const fetched = (await api.get<GenerationJob[K]>(detail.url(jobId))).data;
      return detail.storeFetched(queryClient, previous, fetched);
    },
    enabled: jobId.length > 0,
    // List seeds and websocket patches keep this fresh; a mount right after one must not refetch.
    staleTime: 30_000,
    refetchOnMount: detail.refetchOnMount,
    refetchInterval: query => detail.refetchInterval(query.state, socketOpen, Date.now()),
    retry: detail.retry,
    ...(detail.retryDelay && { retryDelay: detail.retryDelay }),
  });
}

// 'all', not the default 'active': a card that is unmounted now (another notebook is open) skips its refetch on
// mount, so an invalidation that only marks it stale would leave it showing the old state when it comes back.
const refetchDetail = (queryClient: QueryClient, queryKey: readonly unknown[]): Promise<void> =>
  queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'all' });

/**
 * Applies one `generation_job_updated` frame. A frame carries the stored error (internal code, possibly provider
 * wording) and no signed URL, so only state and progress are applied; a terminal frame refetches the job for its
 * public error and output.
 */
export async function applyGenerationJobUpdate(queryClient: QueryClient, job: JobUpdate): Promise<void> {
  const isTerminal = isTerminalGenerationState(job.state);
  const pending: Promise<void>[] = [];
  if (isTerminal) pending.push(invalidateGenerationCreditBalances(queryClient));

  if (job.kind === 'render') {
    // The export panel's list carries the progress, output file and public error, none of which a frame has.
    pending.push(queryClient.invalidateQueries({ queryKey: studioRenderKeys.all }));
  } else if (isReadableKind(job.kind)) {
    const { list, detail, live } = GENERATION_JOB_SOURCES[job.kind];
    const isListed = live.patch(queryClient, job);
    // A job started on another surface (the API, the chat tool) while the gallery is open.
    if ((!isListed || (isTerminal && live.refetchListOnTerminal)) && queryClient.getQueryData(list.key)) {
      pending.push(queryClient.invalidateQueries({ queryKey: list.key }));
    }
    const detailKey = detail.key(job.id);
    if (isTerminal && queryClient.getQueryState(detailKey)) pending.push(refetchDetail(queryClient, detailKey));
  }
  await Promise.all(pending);
}

/** Frames sent while the socket was down are lost: refetch every gallery and each job that can still change. */
export function refetchUnfinishedGenerationJobs(queryClient: QueryClient): void {
  for (const { list, detail } of Object.values(GENERATION_JOB_SOURCES)) {
    void queryClient.invalidateQueries({ queryKey: list.key });
    for (const [key, job] of queryClient.getQueriesData<PollableGenerationJob>({ queryKey: detail.details })) {
      if (job && (!isTerminalGenerationState(job.state) || isAwaitingGenerationOutput(job))) {
        void refetchDetail(queryClient, key);
      }
    }
  }
  void queryClient.invalidateQueries({ queryKey: studioRenderKeys.all });
}
