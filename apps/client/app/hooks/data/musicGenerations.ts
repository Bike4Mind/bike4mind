import { isAxiosError } from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { MusicGeneration } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ReadyState, useWebsocket } from '@client/app/contexts/WebsocketContext';
import { fabFileKeys } from './fabFileKeys';
import { generationJobPollInterval } from './generationJobPolling';
import { upsertMusicGeneration } from './musicGenerationCache';
import { musicGenerationKeys } from './musicGenerationKeys';
import { GENERATION_RATE_LIMITED_MESSAGE } from './videoGenerationErrors';

const musicJobUrl = (jobId: string): string => `/api/v1/music-generations/${encodeURIComponent(jobId)}`;

/** The fallback poll for one music job; live updates normally arrive over the websocket (GenerationUpdatesListener). */
export const musicGenerationPollInterval = (
  job: MusicGeneration | undefined,
  socketOpen: boolean,
  now: number
): number | false => generationJobPollInterval(job, socketOpen, now);

export function useMusicGeneration(jobId: string) {
  const { readyState } = useWebsocket();
  const queryClient = useQueryClient();
  const socketOpen = readyState === ReadyState.OPEN;
  return useQuery({
    queryKey: musicGenerationKeys.detail(jobId),
    queryFn: async () => {
      const previous = queryClient.getQueryData<MusicGeneration>(musicGenerationKeys.detail(jobId));
      const job = (await api.get<MusicGeneration>(musicJobUrl(jobId))).data;
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

export function useCancelMusicGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) => (await api.post<MusicGeneration>(`${musicJobUrl(jobId)}/cancel`)).data,
    // The job usually comes back still running with the cancel queued; the websocket delivers `cancelled`.
    onSuccess: job => upsertMusicGeneration(queryClient, job),
    onError: error =>
      toast.error(
        isAxiosError(error) && error.response?.status === 429
          ? GENERATION_RATE_LIMITED_MESSAGE
          : 'Could not cancel the song. Try again.'
      ),
  });
}
