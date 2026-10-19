import { isAxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateMusicGenerationBody, MusicGeneration, PublicMusicModel } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { hasGenerationCreditSettlementChanged, invalidateGenerationCreditBalances } from './generationCreditBalances';
import { fabFileKeys } from './fabFileKeys';
import { switcherBillingTarget } from './generationBillingTarget';
import {
  generationJobPollInterval,
  generationListRefreshInterval,
  isTerminalGenerationState,
} from './generationJobPolling';
import {
  prependMusicGeneration,
  reconcileFetchedMusicGeneration,
  reconcileFetchedMusicGenerationPage,
  upsertMusicGeneration,
  type MusicGenerationPage,
} from './musicGenerationCache';
import {
  describeMusicCancelError,
  describeMusicGenerationError,
  isMusicNotCancellableError,
} from './musicGenerationErrors';
import { musicGenerationKeys } from './musicGenerationKeys';

export const MUSIC_GALLERY_PAGE_SIZE = 12;

const MUSIC_GENERATIONS_URL = '/api/v1/music-generations';

const musicJobUrl = (jobId: string): string => `${MUSIC_GENERATIONS_URL}/${encodeURIComponent(jobId)}`;

/** The fallback poll for one music job; live updates normally arrive over the websocket (GenerationUpdatesListener). */
export const musicGenerationPollInterval = (
  job: MusicGeneration | undefined,
  socketOpen: boolean,
  now: number
): number | false => generationJobPollInterval(job, socketOpen, now);

export function useMusicModels() {
  return useQuery({
    queryKey: musicGenerationKeys.models,
    queryFn: async () => (await api.get<{ models: PublicMusicModel[] }>('/api/v1/music-models')).data.models,
    staleTime: 5 * 60_000,
  });
}

/** The Studio gallery: the caller's music jobs, newest first, from every source (Studio, chat, API). */
export function useMusicGenerations() {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: musicGenerationKeys.list,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<MusicGenerationPage>(MUSIC_GENERATIONS_URL, {
        params: { limit: MUSIC_GALLERY_PAGE_SIZE, ...(pageParam && { cursor: pageParam }) },
      });
      const previousJobs = new Map(
        response.data.data.map(job => [
          job.id,
          queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail(job.id)),
        ])
      );
      const page = reconcileFetchedMusicGenerationPage(queryClient, response.data);
      if (page.data.some(job => hasGenerationCreditSettlementChanged(previousJobs.get(job.id), job))) {
        void invalidateGenerationCreditBalances(queryClient);
      }
      return page;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    refetchInterval: query => generationListRefreshInterval(query.state.data, Date.now()),
  });
}

export function useMusicGeneration(jobId: string) {
  const { readyState } = useWebsocket();
  const queryClient = useQueryClient();
  const socketOpen = readyState === ReadyState.OPEN;
  return useQuery({
    queryKey: musicGenerationKeys.detail(jobId),
    queryFn: async () => {
      const previous = queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail(jobId));
      const job = reconcileFetchedMusicGeneration(
        queryClient,
        (await api.get<MusicGeneration>(musicJobUrl(jobId))).data
      );
      if (hasGenerationCreditSettlementChanged(previous, job)) {
        void invalidateGenerationCreditBalances(queryClient);
      }
      // The song's file is saved after the chat turn ended, past the one-shot session-files refresh that follows
      // it (useSubscribeChatCompletion), so refresh the file lists once the file first shows up.
      if (previous && !previous.output?.file_id && job.output?.file_id) {
        void queryClient.invalidateQueries({ queryKey: fabFileKeys.own });
      }
      return job;
    },
    enabled: jobId.length > 0,
    // Websocket patches keep this fresh; a mount right after one must not refetch.
    staleTime: 30_000,
    refetchOnMount: false,
    refetchInterval: query => musicGenerationPollInterval(query.state.data, socketOpen, Date.now()),
    retry: (failureCount, error) => {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      return status !== 404 && status !== 429 && failureCount < 3;
    },
  });
}

export function useCreateMusicGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateMusicGenerationBody) =>
      (await api.post<MusicGeneration>(MUSIC_GENERATIONS_URL, { ...body, ...switcherBillingTarget() })).data,
    onSuccess: job => {
      prependMusicGeneration(queryClient, job);
      void invalidateGenerationCreditBalances(queryClient);
      toast.success('Song generation started');
    },
    onError: error => toast.error(describeMusicGenerationError(error, 'Could not start the song. Try again.')),
  });
}

export function useCancelMusicGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => (await api.post<MusicGeneration>(`${musicJobUrl(jobId)}/cancel`)).data,
    // The job may come back still live with the cancel queued; the websocket then delivers `cancelled`.
    onSuccess: job => {
      upsertMusicGeneration(queryClient, job);
      const latest = queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail(job.id));
      if (latest && isTerminalGenerationState(latest.state) && latest.credits.settled !== null) {
        void invalidateGenerationCreditBalances(queryClient);
      }
    },
    onError: (error, jobId) => {
      toast.error(describeMusicCancelError(error));
      // The song started composing since the card last heard; refetch so it shows `running` and drops Cancel.
      if (isMusicNotCancellableError(error)) {
        void queryClient.invalidateQueries({ queryKey: musicGenerationKeys.detail(jobId) });
      }
    },
  });
}
