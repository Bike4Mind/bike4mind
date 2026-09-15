import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export type CodeAgentEventType =
  | 'status'
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'permission_resolved';

export interface CodeAgentEvent {
  id: string;
  type: CodeAgentEventType;
  status?: string;
  role?: 'user' | 'assistant';
  text?: string;
  tool?: string;
  toolUseId?: string;
  isError?: boolean;
  /** Set for `permission_request` / `permission_resolved`. */
  requestId?: string;
  /** Set for `permission_request`: the gated tool name. */
  toolName?: string;
  /** Set for `permission_resolved`: the user's allow/deny answer. */
  allow?: boolean;
  /** Set for `permission_resolved`: who resolved it. */
  resolvedBy?: 'user' | 'auto';
  occurredAt: string;
  createdAt: string;
}

export interface CodeAgentEventPage {
  events: CodeAgentEvent[];
  nextCursor: string | null;
}

/**
 * Infinite-scroll fetch of the transcript for a single CC agent instance.
 * Returns pages newest-first. `fetchNextPage` loads older events.
 *
 * `enabled` gates the query: pass `false` to skip fetching while the
 * modal is closed. Staying mounted avoids a full re-fetch on every
 * open/close toggle.
 */
export function useCodeAgentEvents(params: { instanceId: string | null; enabled?: boolean; pageSize?: number }) {
  const { instanceId, enabled = true, pageSize = 50 } = params;
  return useInfiniteQuery<CodeAgentEventPage>({
    queryKey: ['cc-bridge', 'events', instanceId, pageSize],
    queryFn: async ({ pageParam }) => {
      if (!instanceId) throw new Error('instanceId required');
      const query: Record<string, string> = { instanceId, limit: String(pageSize) };
      if (pageParam) query.before = pageParam as string;
      const response = await api.get<CodeAgentEventPage>('/api/cc-bridge/events', { params: query });
      return response.data;
    },
    getNextPageParam: lastPage => lastPage.nextCursor,
    initialPageParam: undefined as string | undefined,
    enabled: Boolean(instanceId) && enabled,
    // Events are append-only per instance, so cached pages stay valid
    // indefinitely. Consumers refresh the tail explicitly via
    // `queryClient.invalidateQueries` when `lastEventAt` bumps.
    staleTime: Infinity,
    // Without an explicit gcTime the infinite pages for every instance the
    // user has ever opened accumulate for the session. 30 min after the
    // modal is closed (query `enabled` flips false) the cache is reaped;
    // reopening the same instance refetches page 1.
    gcTime: 30 * 60_000,
  });
}
