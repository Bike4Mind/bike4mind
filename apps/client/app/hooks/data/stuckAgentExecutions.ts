import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { AgentExecutionStatus } from '@client/app/stores/useAgentExecutionStore';

/**
 * Client-side mirror of the row shape returned by
 * `/api/admin/agent-executions/stuck`. Duplicated rather than imported from
 * `@bike4mind/database` because the database barrel transitively pulls in
 * server-only AWS SDK modules that fail to bundle into the client.
 */
export type StuckExecutionItem = {
  id: string;
  userId: string;
  organizationId?: string;
  sessionId: string;
  questId: string;
  query: string;
  model: string;
  status: AgentExecutionStatus;
  totalCreditsUsed: number;
  lambdaInvocationCount: number;
  isBackgroundExecution?: boolean;
  spawnedByExecutionId?: string;
  parentExecutionId?: string;
  startedAt?: string;
  completedAt?: string;
  abortedAt?: string;
  createdAt: string;
  updatedAt: string;
  totalIterations?: number;
  errorMessage?: string;
  /**
   * Confidence-gate telemetry (#56 M1.1); omitted when the gate never evaluated.
   * `avgConfidence` is derived server-side from the stored confidence sum.
   */
  confidenceTelemetry?: {
    evaluatedCount: number;
    emittedCount: number;
    minConfidence: number;
    avgConfidence: number;
  };
};

export type StuckExecutionsResponse = {
  items: StuckExecutionItem[];
  olderThanMinutes: number;
};

export type CleanupResponse = {
  requested: number;
  marked: number;
  notifiedConnections: number;
};

const QUERY_KEY = ['admin', 'agent-executions', 'stuck'] as const;

export const useStuckAgentExecutions = (params: {
  minutes: number;
  status?: AgentExecutionStatus;
  userId?: string;
  limit?: number;
}) => {
  return useQuery({
    queryKey: [...QUERY_KEY, params],
    queryFn: async () => {
      const response = await api.get<StuckExecutionsResponse>('/api/admin/agent-executions/stuck', {
        params: {
          minutes: params.minutes,
          ...(params.status ? { status: params.status } : {}),
          ...(params.userId ? { userId: params.userId } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        },
      });
      return response.data;
    },
    staleTime: 15 * 1000,
    refetchInterval: 30 * 1000,
    placeholderData: keepPreviousData,
  });
};

export const useCleanupAgentExecutions = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (executionIds: string[]) => {
      const response = await api.post<CleanupResponse>('/api/admin/agent-executions/cleanup', {
        executionIds,
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });
};
