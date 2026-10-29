import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { ILoop, ILoopWithUsage, LoopStatus, WorkItemStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';

/** One ticket as served by GET /api/loops/:id/tickets (apps/client/pages/api/loops/[id]/tickets.ts). */
export interface ILoopTicket {
  id: string;
  title: string;
  description?: string;
  stage?: string;
  status: WorkItemStatus;
  statusReason?: string;
  dependencies: string[];
  executionId?: string;
  /** Open with every dependency closed: the scheduler works the oldest of these next. */
  ready: boolean;
  updatedAt: string;
}

export interface ILoopTicketsResponse {
  stages: { stage: string; tickets: ILoopTicket[] }[];
}

/** Every loops query shares the `['loops']` prefix, so one invalidation refreshes list, detail and tickets. */
export const loopKeys = {
  all: ['loops'] as const,
  detail: (id: string) => ['loops', id] as const,
  tickets: (id: string) => ['loops', id, 'tickets'] as const,
};

export type LoopFormPayload = Pick<ILoop, 'name' | 'goal' | 'intervalMinutes' | 'tools' | 'stages'> & {
  agentId?: string | null;
};

const LIST_POLL_MS = 30_000;
const DETAIL_POLL_MS = 15_000;

/** A 409 means the loop moved under us (e.g. the scheduler errored it): show why and reload. */
function onLoopError(queryClient: QueryClient) {
  return (error: unknown) => {
    toast.error(getErrorMessage(error));
    if (isAxiosError(error) && error.response?.status === 409) {
      queryClient.invalidateQueries({ queryKey: loopKeys.all });
    }
  };
}

function useLoopMutation<TVars>(fn: (vars: TVars) => Promise<unknown>, onSuccess?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      onSuccess?.();
      return queryClient.invalidateQueries({ queryKey: loopKeys.all });
    },
    onError: onLoopError(queryClient),
  });
}

export const useLoops = (enabled: boolean) =>
  useQuery({
    queryKey: loopKeys.all,
    queryFn: async () => (await api.get<ILoopWithUsage[]>('/api/loops')).data,
    enabled,
    refetchInterval: LIST_POLL_MS,
  });

export const useLoop = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: async () => (await api.get<ILoopWithUsage>(`/api/loops/${id}`)).data,
    enabled: enabled && !!id,
    refetchInterval: DETAIL_POLL_MS,
    retry: (count, error) => !(isAxiosError(error) && error.response?.status === 404) && count < 3,
  });

export const useLoopTickets = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: loopKeys.tickets(id),
    queryFn: async () => (await api.get<ILoopTicketsResponse>(`/api/loops/${id}/tickets`)).data,
    enabled: enabled && !!id,
    refetchInterval: DETAIL_POLL_MS,
  });

export const useCreateLoop = () =>
  useLoopMutation(async (payload: LoopFormPayload) => (await api.post<ILoop>('/api/loops', payload)).data);

export const useUpdateLoop = () =>
  useLoopMutation(
    async ({ id, ...patch }: Partial<LoopFormPayload> & { id: string; status?: LoopStatus }) =>
      (await api.patch<ILoop>(`/api/loops/${id}`, patch)).data
  );

export const useDeleteLoop = () => useLoopMutation((id: string) => api.delete(`/api/loops/${id}`));

export const useRunLoop = () =>
  useLoopMutation(
    (id: string) => api.post(`/api/loops/${id}/run`),
    () => toast.success('Runs within 5 minutes')
  );

export const useCreateLoopTicket = () =>
  useLoopMutation((body: { loopId: string; title: string; description?: string; stage: string }) =>
    api.post('/api/work-items', body)
  );

export const useMoveLoopTicket = () =>
  useLoopMutation(({ id, stage }: { id: string; stage: string }) => api.patch(`/api/work-items/${id}`, { stage }));
