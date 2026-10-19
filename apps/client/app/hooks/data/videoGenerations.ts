import { isAxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateVideoGenerationBody, VideoGeneration, VideoModel } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { CREDITS_BALANCE_KEY } from './credits';
import { switcherBillingTarget } from './generationBillingTarget';
import {
  prependVideoGeneration,
  reconcileFetchedVideoGeneration,
  reconcileFetchedVideoGenerationPage,
  upsertVideoGeneration,
  type VideoGenerationList,
  type VideoGenerationPage,
} from './videoGenerationCache';
import { generationJobPollInterval, generationListRefreshInterval } from './generationJobPolling';
import { describeVideoGenerationError } from './videoGenerationErrors';
import { videoGenerationKeys } from './videoGenerationKeys';

export const VIDEO_GALLERY_PAGE_SIZE = 12;

export {
  AWAITING_OUTPUT_MAX_POLL_AGE_MS,
  DETAIL_URL_REFRESH_LEAD_MS,
  LIST_URL_REFRESH_LEAD_MS,
  PENDING_SCAN_MAX_POLL_MS,
  PENDING_SCAN_POLL_MS,
  SOCKET_DOWN_POLL_MS,
  URL_REFRESH_FLOOR_MS,
} from './generationJobPolling';

/** The fallback poll for one video job; live updates normally arrive over the websocket (GenerationUpdatesListener). */
export const videoGenerationPollInterval = (
  job: VideoGeneration | undefined,
  socketOpen: boolean,
  now: number
): number | false => generationJobPollInterval(job, socketOpen, now);

export const videoListRefreshInterval = (list: VideoGenerationList | undefined, now: number): number | false =>
  generationListRefreshInterval(list, now);

export function useVideoModels() {
  return useQuery({
    queryKey: videoGenerationKeys.models,
    queryFn: async () => (await api.get<{ models: VideoModel[] }>('/api/v1/video-models')).data.models,
    staleTime: 5 * 60_000,
  });
}

export function useVideoGenerations() {
  const queryClient = useQueryClient();
  return useInfiniteQuery({
    queryKey: videoGenerationKeys.list,
    queryFn: async ({ pageParam }) => {
      const response = await api.get<VideoGenerationPage>('/api/v1/video-generations', {
        params: { limit: VIDEO_GALLERY_PAGE_SIZE, ...(pageParam && { cursor: pageParam }) },
      });
      return reconcileFetchedVideoGenerationPage(queryClient, response.data);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    refetchInterval: query => videoListRefreshInterval(query.state.data, Date.now()),
  });
}

export function useVideoGeneration(jobId: string) {
  const { readyState } = useWebsocket();
  const queryClient = useQueryClient();
  const socketOpen = readyState === ReadyState.OPEN;
  return useQuery({
    queryKey: videoGenerationKeys.detail(jobId),
    queryFn: async () =>
      reconcileFetchedVideoGeneration(
        queryClient,
        (await api.get<VideoGeneration>(`/api/v1/video-generations/${encodeURIComponent(jobId)}`)).data
      ),
    enabled: jobId.length > 0,
    // List seeds and websocket patches keep this fresh; a mount right after a seed must not refetch.
    staleTime: 30_000,
    // The list refetch re-seeds detail entries; an uncached card has no data and still fetches on mount.
    refetchOnMount: false,
    refetchInterval: query => videoGenerationPollInterval(query.state.data, socketOpen, Date.now()),
    retry: (failureCount, error) => {
      const status = isAxiosError(error) ? error.response?.status : undefined;
      return status !== 404 && status !== 429 && failureCount < 3;
    },
  });
}

export function useCreateVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateVideoGenerationBody) =>
      (await api.post<VideoGeneration>('/api/v1/video-generations', { ...body, ...switcherBillingTarget() })).data,
    onSuccess: job => {
      prependVideoGeneration(queryClient, job);
      void queryClient.invalidateQueries({ queryKey: CREDITS_BALANCE_KEY });
      toast.success('Video generation started');
    },
    onError: error => toast.error(describeVideoGenerationError(error, 'Could not start the video. Try again.')),
  });
}

export function useCancelVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) =>
      (await api.post<VideoGeneration>(`/api/v1/video-generations/${encodeURIComponent(jobId)}/cancel`)).data,
    // The job usually comes back still running with the cancel queued; the websocket delivers `cancelled`.
    onSuccess: job => upsertVideoGeneration(queryClient, job),
    onError: error => toast.error(describeVideoGenerationError(error, 'Could not cancel the video. Try again.')),
  });
}
