import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateMusicGenerationBody, MusicGeneration, PublicMusicModel } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { invalidateGenerationCreditBalances } from './generationCreditBalances';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';
import { switcherBillingTarget } from './generationBillingTarget';
import { isTerminalGenerationState } from './generationJobPolling';
import { prependMusicGeneration, upsertMusicGeneration } from './musicGenerationCache';
import {
  describeMusicCancelError,
  describeMusicGenerationError,
  isMusicNotCancellableError,
} from './musicGenerationErrors';
import { musicGenerationKeys } from './musicGenerationKeys';

const MUSIC_GENERATIONS_URL = '/api/v1/music-generations';

const musicJobUrl = (jobId: string): string => `${MUSIC_GENERATIONS_URL}/${encodeURIComponent(jobId)}`;

export function useMusicModels() {
  return useQuery({
    queryKey: musicGenerationKeys.models,
    queryFn: async () => (await api.get<{ models: PublicMusicModel[] }>('/api/v1/music-models')).data.models,
    staleTime: 5 * 60_000,
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
    // Snapshot the billed account at submit so an error names who was charged even if the switcher moves meanwhile.
    onMutate: () => ({ billingAccount: useSelectedAccount.getState().selectedAccount }),
    onError: (error, _body, context) =>
      toast.error(
        describeMusicGenerationError(error, 'Could not start the song. Try again.', context?.billingAccount ?? null)
      ),
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
