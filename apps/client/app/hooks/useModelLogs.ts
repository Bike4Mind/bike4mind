import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

export interface ModelLog {
  id: string;
  timestamp: string;
  model: {
    name: string;
    type: string;
    backend: string;
    parameters: {
      temperature: number;
      topP: number;
      maxTokens: number;
      presencePenalty?: number;
      frequencyPenalty?: number;
    };
  };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost?: number;
    creditsUsed?: number;
  };
  context: {
    attachedFiles?: Array<{
      name: string;
      type: string;
      size: number;
      mimeType?: string;
      lastModified?: string;
    }>;
    messageHistoryLength: number;
    systemPrompt?: string;
    userPrompt?: string;
  };
  performance: {
    totalResponseTime: number;
    contextRetrievalTime?: number;
    modelInferenceTime?: number;
    streamingPerformance?: {
      firstTokenTime?: number;
      tokensPerSecond?: number;
    };
  };
  executionTracking?: {
    steps: string[];
    currentStep?: string;
    completedSteps?: string[];
    failedSteps?: string[];
    results?: Record<string, any>;
    errors?: Record<string, string>;
  };
  artifacts?: Array<{
    type: string;
    content: string;
    metadata?: Record<string, any>;
    timestamp: string;
  }>;
  session: {
    id: string;
    userId?: string;
    organizationId?: string;
    projectId?: string;
    agentId?: string;
    agentName?: string;
  };
}

/** One row of the paginated list: only what a card renders. The full log is {@link ModelLog}. */
export interface ModelLogSummary {
  id: string;
  timestamp: string;
  modelName?: string;
  totalResponseTime?: number;
  inputTokens?: number;
  outputTokens?: number;
  attachedFileCount: number;
  messageHistoryLength?: number;
  completedStepCount: number;
  failedStepCount: number;
  artifacts: Array<{ type: string; preview: string }>;
}

interface UseModelLogsOptions {
  startDate?: string;
  endDate?: string;
  model?: string;
  search?: string;
  page: number;
  limit: number;
}

export interface ModelLogsResponse {
  logs: ModelLogSummary[];
  total: number;
  page: number;
  limit: number;
}

export function useModelLogs(options: UseModelLogsOptions) {
  return useQuery<ModelLogsResponse>({
    queryKey: ['modelLogs', options],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(options.page), limit: String(options.limit) });
      if (options.startDate) params.append('startDate', options.startDate);
      if (options.endDate) params.append('endDate', options.endDate);
      if (options.model) params.append('model', options.model);
      if (options.search) params.append('search', options.search);

      const response = await api.get(`/api/admin/model-logs?${params.toString()}`);
      return response.data;
    },
    placeholderData: keepPreviousData,
  });
}

export function useModelLogDetail(id: string, enabled: boolean) {
  return useQuery<ModelLog>({
    queryKey: ['modelLogDetail', id],
    queryFn: async () => {
      const response = await api.get(`/api/admin/model-logs/${encodeURIComponent(id)}`);
      return response.data;
    },
    enabled,
  });
}
