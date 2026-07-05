import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { IAgent } from '@bike4mind/common';
import useSessionLayout from '@client/app/hooks/useSessionLayout';
import { isOptimisticId } from '@client/app/utils/llm';

export const useGetAgents = (enabled: boolean = true) => {
  return useQuery({
    queryKey: ['agents'],
    queryFn: async (): Promise<IAgent[]> => {
      const response = await api.get<{ data: IAgent[]; hasMore: boolean; total: number }>('/api/agents');
      return response.data.data;
    },
    enabled,
    staleTime: 5 * 60 * 1000, // 5 minutes - only refetch when agents actually change
    refetchOnWindowFocus: false, // Prevent refetch when switching tabs/windows
    refetchOnReconnect: false, // Prevent refetch on network reconnection
  });
};

export const useGetSessionAgents = (sessionId: string | null) => {
  const pendingOptimisticId = useSessionLayout(s => s.pendingOptimisticId);
  // Suppress the network request while the session is in the optimistic
  // pre-navigation window, or if the ID is still an optimistic placeholder -
  // hitting the server with a client-only ID would 500.
  //
  // Keep the queryKey scoped to the actual `sessionId`, NOT a remapped `null`.
  // Callers like `useSendMessage` and `AgentBench` invalidate via
  // `queryClient.invalidateQueries({ queryKey: ['session-agents', <id>] })` using
  // the live session id - if the read site re-keyed to `null` those invalidations
  // would silently no-op on optimistic sessions.
  const isOptimistic = isOptimisticId(sessionId) || (!!pendingOptimisticId && sessionId === pendingOptimisticId);

  return useQuery({
    queryKey: ['session-agents', sessionId],
    queryFn: async (): Promise<IAgent[]> => {
      const response = await api.get<{ agents: IAgent[] }>(`/api/sessions/${sessionId}/agents`);
      return response.data.agents;
    },
    enabled: !!sessionId && !isOptimistic,
    staleTime: 5 * 60 * 1000, // 5 minutes - session agents don't change often
    refetchOnWindowFocus: false, // Prevent refetch when switching tabs/windows
    refetchOnReconnect: false, // Prevent refetch on network reconnection
  });
};
