import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

interface AnalyticsMetricResponse {
  id: string;
  timestamp: string;
  model: {
    name: string;
    type?: string;
    backend?: string;
    parameters?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    };
  };
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
    creditsUsed?: number;
  };
  performance: {
    totalResponseTime?: number;
    contextRetrievalTime?: number;
    modelInferenceTime?: number;
    firstTokenTime?: number;
    clientFirstTokenTime?: number;
    processPickupTime?: number;
    streamingPerformance?: {
      chunkCount?: number;
      totalStreamTime?: number;
      charsPerSecond?: number;
    };
    featureExecutionTimes?: Record<string, number>;
    databaseOperationTimes?: Record<string, number>;
  };
  session: {
    userId?: string;
    organizationId?: string;
    projectId?: string;
  };
  status: string;
}

interface AnalyticsMetricsFilters {
  dateFrom?: string;
  dateTo?: string;
  userFilter?: string;
  modelFilter?: string;
  statusFilter?: string;
}

export function useAnalyticsMetrics(filters: AnalyticsMetricsFilters = {}) {
  return useQuery({
    queryKey: ['analytics-metrics', filters],
    queryFn: async (): Promise<AnalyticsMetricResponse[]> => {
      const params = new URLSearchParams();

      if (filters.dateFrom) params.append('dateFrom', filters.dateFrom);
      if (filters.dateTo) params.append('dateTo', filters.dateTo);
      if (filters.userFilter) params.append('userFilter', filters.userFilter);
      if (filters.modelFilter) params.append('modelFilter', filters.modelFilter);
      if (filters.statusFilter) params.append('statusFilter', filters.statusFilter);

      const response = await api.get(`/api/admin/analytics?${params.toString()}`);
      return response.data;
    },
    staleTime: 1000 * 60 * 2, // 2 minutes
  });
}
