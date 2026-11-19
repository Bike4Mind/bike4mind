/**
 * Studio Productions' exports (apps/client/pages/api/studio/compositions/[id]/renders): one render job per output
 * size. The websocket (GenerationUpdatesListener) invalidates these keys on every render frame; the polling here is
 * only the fallback for a dropped socket.
 */
import { isAxiosError } from 'axios';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { StudioRenderCreateResponseSchema, StudioRenderJobListSchema, type StudioRenderJob } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { invalidateGenerationCreditBalances } from './generationCreditBalances';

const rendersUrl = (compositionId: string) => `/api/studio/compositions/${compositionId}/renders`;

export const studioRenderKeys = {
  all: ['studioRenders'] as const,
  list: (compositionId: string) => ['studioRenders', 'list', compositionId] as const,
};

const POLL_INTERVAL_MS = 5000;

const IN_FLIGHT_STATES: ReadonlySet<StudioRenderJob['state']> = new Set(['pending', 'running', 'storing']);

export const isRenderInFlight = (job: Pick<StudioRenderJob, 'state'>): boolean => IN_FLIGHT_STATES.has(job.state);

export function useStudioRenders(compositionId: string) {
  return useQuery({
    queryKey: studioRenderKeys.list(compositionId),
    queryFn: async (): Promise<StudioRenderJob[]> => {
      const { data } = await api.get<unknown>(rendersUrl(compositionId));
      return StudioRenderJobListSchema.parse(data).data;
    },
    refetchInterval: query => (query.state.data?.some(isRenderInFlight) ? POLL_INTERVAL_MS : false),
  });
}

/** The refusal's user-facing text: the route puts the code under `error` and the readable sentence under `message`. */
export const renderErrorMessage = (error: unknown): string => {
  if (isAxiosError(error) && typeof error.response?.data === 'object' && error.response.data !== null) {
    const { message } = error.response.data as { message?: unknown };
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'The export could not be started. Try again.';
};

export function useCreateStudioRenders(compositionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (outputIds: string[]) => {
      const { data } = await api.post<unknown>(rendersUrl(compositionId), { outputIds });
      return StudioRenderCreateResponseSchema.parse(data);
    },
    onSuccess: async () => {
      void invalidateGenerationCreditBalances(queryClient);
      await queryClient.invalidateQueries({ queryKey: studioRenderKeys.list(compositionId) });
    },
  });
}
