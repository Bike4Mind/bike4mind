import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type { ILoop, ILoopEvent, ILoopWithUsage, LoopGateOutcome, LoopStatus, WorkItemStatus } from '@bike4mind/common';
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
  createdAt: string;
  updatedAt: string;
}

/** One event as served by GET /api/loops/:id/events (apps/client/pages/api/loops/[id]/events.ts). */
export type ILoopEventRow = Pick<
  ILoopEvent,
  'id' | 'kind' | 'executionId' | 'workItemId' | 'ticketTitle' | 'iteration' | 'confidence' | 'reason'
> & {
  resolution?: { outcome: LoopGateOutcome; by?: string; at: string };
  createdAt: string;
};

/** Unsure events nobody has answered yet. */
export const countNeedsYou = (events: ILoopEventRow[] = []) =>
  events.filter(event => event.kind === 'unsure' && !event.resolution).length;

export interface ILoopTicketsResponse {
  stages: { stage: string; tickets: ILoopTicket[] }[];
}

/** Every loops query shares the `['loops']` prefix, so one invalidation refreshes list, detail, tickets and events. */
export const loopKeys = {
  all: ['loops'] as const,
  detail: (id: string) => ['loops', id] as const,
  tickets: (id: string) => ['loops', id, 'tickets'] as const,
  events: (id: string) => ['loops', id, 'events'] as const,
};

export type LoopFormPayload = Pick<ILoop, 'name' | 'goal' | 'intervalMinutes' | 'tools' | 'stages'> & {
  agentId?: string | null;
};

const LIST_POLL_MS = 30_000;
const DETAIL_POLL_MS = 15_000;

/** A 409 means the loop or ticket moved under us (e.g. a run claimed it): show why and reload. */
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

export const useLoops = () =>
  useQuery({
    queryKey: loopKeys.all,
    queryFn: async () => (await api.get<ILoopWithUsage[]>('/api/loops')).data,
    refetchInterval: LIST_POLL_MS,
  });

export const useLoop = (id: string) =>
  useQuery({
    queryKey: loopKeys.detail(id),
    queryFn: async () => (await api.get<ILoopWithUsage>(`/api/loops/${id}`)).data,
    enabled: !!id,
    refetchInterval: DETAIL_POLL_MS,
  });

export const useLoopTickets = (id: string) =>
  useQuery({
    queryKey: loopKeys.tickets(id),
    queryFn: async () => (await api.get<ILoopTicketsResponse>(`/api/loops/${id}/tickets`)).data,
    enabled: !!id,
    refetchInterval: DETAIL_POLL_MS,
  });

export const useLoopEvents = (id: string) =>
  useQuery({
    queryKey: loopKeys.events(id),
    queryFn: async () => (await api.get<ILoopEventRow[]>(`/api/loops/${id}/events`)).data,
    enabled: !!id,
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
