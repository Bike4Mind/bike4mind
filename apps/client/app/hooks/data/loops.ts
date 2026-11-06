import {
  useMutation,
  useQuery,
  useQueryClient,
  type InvalidateQueryFilters,
  type QueryClient,
} from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import type {
  ILoop,
  ILoopDirective,
  ILoopDirectiveReply,
  ILoopEvent,
  ILoopsBudget,
  ILoopWithUsage,
  LoopDirectiveOwnerAction,
  LoopGateOutcome,
  LoopStatus,
  WorkItemBlocker,
  WorkItemPriority,
  WorkItemStatus,
} from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import type { AgentExecutionTrace } from '@client/app/hooks/data/agentExecutions';
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
  /** Runs that claimed it since its owner last moved it; the loop blocks it at `runLimit`. */
  runCount: number;
  /** Absent: untriaged, waiting for the loop's triage run. */
  priority?: WorkItemPriority;
  /** The p2 cap set it to p3; any owner priority edit clears it. */
  demoted: boolean;
  /** Split into child tickets (its dependencies); closes once they all close. */
  epic: boolean;
  /** Epics only: children closed or gone. */
  childrenDone?: number;
  /** A p0/p1 waiting past its loop's service level (`serviceLevelBreach`). */
  stale: boolean;
  /** Parked on a condition the scheduler reopens it from, not on its owner. */
  blockedOn?: WorkItemBlocker;
  /** Open with every dependency closed: the scheduler works the highest priority, furthest-along, then oldest, next. */
  ready: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An unsure event as served by GET /api/loops/:id/events (apps/client/pages/api/loops/[id]/events.ts). */
export type ILoopUnsureRow = Pick<
  ILoopEvent,
  'id' | 'kind' | 'source' | 'executionId' | 'workItemId' | 'ticketTitle' | 'iteration' | 'confidence' | 'reason'
> & {
  resolution?: { outcome: LoopGateOutcome; by?: string; at: string; note?: string };
  createdAt: string;
};

/** A directive the loop sent or received, as the same route serves it. */
export type ILoopDirectiveRow = Pick<
  ILoopDirective,
  'id' | 'loopId' | 'fromLoopId' | 'fromLoopName' | 'executionId' | 'instruction' | 'reason' | 'state' | 'action'
> & {
  kind: 'directive';
  replies: (Omit<ILoopDirectiveReply, 'at' | 'userId'> & { at: string; executionId?: string })[];
  createdAt: string;
};

export type ILoopEventRow = ILoopUnsureRow | ILoopDirectiveRow;

/** Unsure events nobody has answered yet. */
export const countNeedsYou = (events: ILoopEventRow[] = []) =>
  events.filter(event => event.kind === 'unsure' && !event.resolution).length;

export interface ILoopTicketsResponse {
  stages: { stage: string; tickets: ILoopTicket[] }[];
  runLimit: number;
  /** The owner's desktop runner, as last reported; null when the loop has no desktop stage. */
  runner?: { online: boolean; lanesFree: number; waitingReason?: string } | null;
}

/**
 * Every loops query shares the `['loops']` prefix. `['loops', id]` covers one loop's detail, tickets and events;
 * the list is `all` matched `exact`. The server pushes `invalidate_query ['loops', id]` when a run changes a loop
 * (apps/client/server/utils/loopDispatch.ts `pushLoopChanged`), so keep these shapes in sync with it.
 */
export const loopKeys = {
  all: ['loops'] as const,
  detail: (id: string) => ['loops', id] as const,
  tickets: (id: string) => ['loops', id, 'tickets'] as const,
  events: (id: string) => ['loops', id, 'events'] as const,
  budget: ['loops', 'budget'] as const,
};

export type LoopFormPayload = Pick<ILoop, 'name' | 'goal' | 'intervalMinutes' | 'tools' | 'stages'> & {
  agentId?: string | null;
  oversees?: string[] | null;
  budgetCreditsPerDay?: number | null;
  maxConcurrent?: number | null;
  stageConfig?: ILoop['stageConfig'];
  serviceLevelHours?: ILoop['serviceLevelHours'] | null;
  p2RunsPerDay?: number | null;
  triageModel?: string | null;
  escalationModel?: string | null;
};

const LIST_POLL_MS = 30_000;
// The WebSocket push is the fast path; this poll is the fallback when it is down.
const DETAIL_POLL_MS = 60_000;

/** A 409 means the loop or ticket moved under us (e.g. a run claimed it): show why and reload. */
function onLoopError(queryClient: QueryClient) {
  return (error: unknown) => {
    toast.error(getErrorMessage(error));
    if (isAxiosError(error) && error.response?.status === 409) {
      queryClient.invalidateQueries({ queryKey: loopKeys.all });
    }
  };
}

const listOnly: InvalidateQueryFilters = { queryKey: loopKeys.all, exact: true };
const oneLoop = (id: string): InvalidateQueryFilters[] => [{ queryKey: loopKeys.detail(id) }, listOnly];

/** `invalidate` names the queries the write touched; they refetch in the background, the mutation does not wait. */
function useLoopMutation<TVars, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
  invalidate: (vars: TVars) => InvalidateQueryFilters[],
  onSuccess?: (data: TData) => void
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      onSuccess?.(data);
      invalidate(vars).forEach(filters => void queryClient.invalidateQueries(filters));
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

/**
 * The run drawer's header: the model a loop run used and whether it was escalated or a triage run, read from the
 * run trace route (pages/api/agent-executions/[id]). Own query key, so a live run's steps are not cached for the
 * chat's "Show reasoning" disclosure, which shares that route.
 */
export const useLoopRunInfo = (executionId?: string) =>
  useQuery({
    queryKey: ['loops', 'run', executionId],
    queryFn: async () => {
      const { data } = await api.get<Pick<AgentExecutionTrace, 'model' | 'escalated' | 'loopRunKind'>>(
        `/api/agent-executions/${executionId}`
      );
      return { model: data.model, escalated: data.escalated, loopRunKind: data.loopRunKind };
    },
    enabled: !!executionId,
    staleTime: Infinity,
  });

export const useLoopsBudget = () =>
  useQuery({
    queryKey: loopKeys.budget,
    queryFn: async () => (await api.get<ILoopsBudget>('/api/loops/budget')).data,
    refetchInterval: LIST_POLL_MS,
  });

/** Sets the caller's all-loops daily cap; null clears it. */
export const useSetLoopsBudget = () =>
  useLoopMutation(
    async (dailyCredits: number | null) => (await api.put<ILoopsBudget>('/api/loops/budget', { dailyCredits })).data,
    () => [{ queryKey: loopKeys.budget }, listOnly]
  );

export const useCreateLoop = () =>
  useLoopMutation(
    async (payload: LoopFormPayload) => (await api.post<ILoop>('/api/loops', payload)).data,
    () => [listOnly]
  );

export const useUpdateLoop = () =>
  useLoopMutation(
    async ({ id, ...patch }: Partial<LoopFormPayload> & { id: string; status?: LoopStatus }) =>
      (await api.patch<ILoop>(`/api/loops/${id}`, patch)).data,
    ({ id }) => oneLoop(id)
  );

/**
 * Unlike the other mutations this must not refetch the deleted loop: its detail, tickets and events queries
 * are still mounted until the caller navigates away, and refetching them is three 404s.
 */
export const useDeleteLoop = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/loops/${id}`),
    onSuccess: async (_data, id) => {
      await queryClient.cancelQueries({ queryKey: loopKeys.detail(id) });
      return queryClient.invalidateQueries({ queryKey: loopKeys.all, predicate: query => query.queryKey[1] !== id });
    },
    onError: onLoopError(queryClient),
  });
};

/** `waitingReason` is set when the run cannot start right away (already running, no free slot, budget, pacing). */
export const useRunLoop = () =>
  useLoopMutation(
    async (id: string) => (await api.post<ILoop & { waitingReason?: string }>(`/api/loops/${id}/run`)).data,
    id => oneLoop(id),
    data => (data?.waitingReason ? toast.info(data.waitingReason) : toast.success('Starting now'))
  );

export const useCreateLoopTicket = () =>
  useLoopMutation(
    (body: { loopId: string; title: string; description?: string; stage: string; priority?: WorkItemPriority }) =>
      api.post('/api/work-items', body),
    ({ loopId }) => [{ queryKey: loopKeys.detail(loopId) }]
  );

export type MoveLoopTicketVars = { loopId: string; id: string; stage?: string; priority?: WorkItemPriority };

/** Shared with LoopTicketBoard, which locks only the cards whose move is still saving. */
export const MOVE_LOOP_TICKET_KEY = ['loops', 'move'] as const;

/**
 * A stage change is an owner move (fresh run allowance); a priority change is not.
 * Optimistic: the card moves in the tickets cache at once and rolls back if the save fails.
 */
export const useMoveLoopTicket = () => {
  const queryClient = useQueryClient();
  const onError = onLoopError(queryClient);
  return useMutation({
    mutationKey: MOVE_LOOP_TICKET_KEY,
    mutationFn: ({ loopId: _loopId, id, ...patch }: MoveLoopTicketVars) => api.patch(`/api/work-items/${id}`, patch),
    onMutate: async ({ loopId, id, stage, priority }) => {
      const key = loopKeys.tickets(loopId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ILoopTicketsResponse>(key);
      if (previous) {
        const ticket = previous.stages.flatMap(group => group.tickets).find(t => t.id === id);
        if (ticket) {
          const moved = { ...ticket, ...(stage && { stage }), ...(priority && { priority }) };
          queryClient.setQueryData<ILoopTicketsResponse>(key, {
            ...previous,
            stages: previous.stages.map(group => {
              const rest = group.tickets.filter(t => t.id !== id);
              return { ...group, tickets: group.stage === (moved.stage ?? '') ? [...rest, moved] : rest };
            }),
          });
        }
      }
      return { previous };
    },
    onError: (error, { loopId }, context) => {
      if (context?.previous) queryClient.setQueryData(loopKeys.tickets(loopId), context.previous);
      // A refused move shows the server's reason (onLoopError); a save that never reached it says the move is undone.
      if (isAxiosError(error) && !error.response) toast.error("Move undone: couldn't reach the server.");
      else onError(error);
    },
    onSettled: (_data, _error, { loopId }) => {
      // The last move to settle refetches, so a refetch does not overwrite a move still saving.
      if (queryClient.isMutating({ mutationKey: MOVE_LOOP_TICKET_KEY }) > 1) return;
      void queryClient.invalidateQueries({ queryKey: loopKeys.tickets(loopId) });
      void queryClient.invalidateQueries({ queryKey: loopKeys.detail(loopId), exact: true });
    },
  });
};

/** Withdraw a directive or overrule a push-back; invalidates every loop, so both sides' logs refresh. */
export const useOverrideDirective = () =>
  useLoopMutation(
    ({
      loopId,
      eventId,
      action,
      note,
    }: {
      loopId: string;
      eventId: string;
      action: LoopDirectiveOwnerAction;
      note?: string;
    }) => api.post(`/api/loops/${loopId}/events/${eventId}/override`, { action, ...(note && { note }) }),
    () => [{ queryKey: loopKeys.all }]
  );

/** The owner's answer to a question a run asked with loop_ticket_unsure; a resume needs the answer as `note`. */
export const useResolveUnsure = () =>
  useLoopMutation(
    async ({
      loopId,
      eventId,
      outcome,
      note,
    }: {
      loopId: string;
      eventId: string;
      outcome: LoopGateOutcome;
      note?: string;
    }) =>
      (
        await api.post<ILoopUnsureRow & { ticketSkipped?: boolean }>(`/api/loops/${loopId}/events/${eventId}/resolve`, {
          outcome,
          ...(note && { note }),
        })
      ).data,
    () => [{ queryKey: loopKeys.all }]
  );
