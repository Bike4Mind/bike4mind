import { isAxiosError } from 'axios';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateVideoGenerationBody, VideoGeneration, VideoModel } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { CREDITS_BALANCE_KEY } from './credits';
import {
  isTerminalVideoState,
  prependVideoGeneration,
  seedVideoGeneration,
  upsertVideoGeneration,
  type VideoGenerationList,
  type VideoGenerationPage,
} from './videoGenerationCache';
import { describeVideoGenerationError } from './videoGenerationErrors';
import { videoGenerationKeys } from './videoGenerationKeys';

export const VIDEO_GALLERY_PAGE_SIZE = 12;
export const SOCKET_DOWN_POLL_MS = 5_000;
export const PENDING_SCAN_POLL_MS = 30_000;
// Signed URLs live 15 minutes (OUTPUT_URL_TTL_SECONDS on the server). The gallery list re-signs a whole page
// first (longer lead) so a page of cards sharing one expiry does not fire one request each: every video route is
// per-user rate-limited, as low as 10/min.
export const DETAIL_URL_REFRESH_LEAD_MS = 60_000;
export const LIST_URL_REFRESH_LEAD_MS = 120_000;
// Used when the refresh time is already past (e.g. a fast client clock), so the interval never reaches 0 and never
// loops tight; stays well above the 10/min per-user rate limit.
export const URL_REFRESH_FLOOR_MS = 60_000;

const msUntil = (expiresAt: string, leadMs: number, now: number): number => {
  const delay = Date.parse(expiresAt) - leadMs - now;
  return delay > 0 ? delay : URL_REFRESH_FLOOR_MS;
};

/** The fallback poll for one job; live updates normally arrive over the websocket (VideoGenerationUpdatesListener). */
export function videoGenerationPollInterval(
  job: VideoGeneration | undefined,
  socketOpen: boolean,
  now: number
): number | false {
  if (!job) return false;
  if (!isTerminalVideoState(job.state)) return socketOpen ? false : SOCKET_DOWN_POLL_MS;
  if (job.state !== 'succeeded' || !job.output) return false;
  if (job.output.availability === 'pending_scan') return PENDING_SCAN_POLL_MS;
  if (job.output.availability === 'ready' && job.output.expires_at) {
    return msUntil(job.output.expires_at, DETAIL_URL_REFRESH_LEAD_MS, now);
  }
  return false;
}

export function videoListRefreshInterval(list: VideoGenerationList | undefined, now: number): number | false {
  const expiries = (list?.pages ?? [])
    .flatMap(page => page.data)
    .flatMap(job => (job.output?.availability === 'ready' && job.output.expires_at ? [job.output.expires_at] : []));
  if (expiries.length === 0) return false;
  const earliest = expiries.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
  return msUntil(earliest, LIST_URL_REFRESH_LEAD_MS, now);
}

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
      response.data.data.forEach(job => seedVideoGeneration(queryClient, job));
      return response.data;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next_cursor ?? undefined,
    refetchInterval: query => videoListRefreshInterval(query.state.data, Date.now()),
  });
}

export function useVideoGeneration(jobId: string) {
  const { readyState } = useWebsocket();
  const socketOpen = readyState === ReadyState.OPEN;
  return useQuery({
    queryKey: videoGenerationKeys.detail(jobId),
    queryFn: async () =>
      (await api.get<VideoGeneration>(`/api/v1/video-generations/${encodeURIComponent(jobId)}`)).data,
    enabled: jobId.length > 0,
    // List seeds and websocket patches keep this fresh; a mount right after a seed must not refetch.
    staleTime: 30_000,
    refetchInterval: query => videoGenerationPollInterval(query.state.data, socketOpen, Date.now()),
    retry: (failureCount, error) => !(isAxiosError(error) && error.response?.status === 404) && failureCount < 3,
  });
}

export function useCreateVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateVideoGenerationBody) =>
      (await api.post<VideoGeneration>('/api/v1/video-generations', body)).data,
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
