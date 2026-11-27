import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateVideoGenerationBody, VideoGeneration, VideoModel } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { invalidateGenerationCreditBalances } from './generationCreditBalances';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { switcherBillingTarget } from './generationBillingTarget';
import { prependVideoGeneration, upsertVideoGeneration } from './videoGenerationCache';
import { isTerminalGenerationState } from './generationJobPolling';
import { describeVideoGenerationError } from './videoGenerationErrors';
import { videoGenerationKeys } from './videoGenerationKeys';

export function useVideoModels() {
  return useQuery({
    queryKey: videoGenerationKeys.models,
    queryFn: async () => (await api.get<{ models: VideoModel[] }>('/api/v1/video-models')).data.models,
    staleTime: 5 * 60_000,
  });
}

export function useCreateVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateVideoGenerationBody) =>
      (await api.post<VideoGeneration>('/api/v1/video-generations', { ...body, ...switcherBillingTarget() })).data,
    onSuccess: job => {
      prependVideoGeneration(queryClient, job);
      void invalidateGenerationCreditBalances(queryClient);
      toast.success('Video generation started');
    },
    // Snapshot the billed account at submit so an error names who was charged even if the switcher moves meanwhile.
    onMutate: () => ({ billingAccount: useSelectedAccount.getState().selectedAccount }),
    onError: (error, _body, context) =>
      toast.error(
        describeVideoGenerationError(error, 'Could not start the video. Try again.', context?.billingAccount ?? null)
      ),
  });
}

export function useCancelVideoGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (jobId: string) =>
      (await api.post<VideoGeneration>(`/api/v1/video-generations/${encodeURIComponent(jobId)}/cancel`)).data,
    // The job usually comes back still running with the cancel queued; the websocket delivers `cancelled`.
    onSuccess: job => {
      upsertVideoGeneration(queryClient, job);
      const latest = queryClient.getQueryData<VideoGeneration>(videoGenerationKeys.detail(job.id));
      if (latest && isTerminalGenerationState(latest.state) && latest.credits.settled !== null) {
        void invalidateGenerationCreditBalances(queryClient);
      }
    },
    onError: error => toast.error(describeVideoGenerationError(error, 'Could not cancel the video. Try again.')),
  });
}
