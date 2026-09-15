import { useQuery } from '@tanstack/react-query';
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

interface UseModelLogsOptions {
  startDate?: string;
  endDate?: string;
  model?: string;
  search?: string;
}

interface ModelLogsResponse {
  logs: ModelLog[];
  total: number;
}

export function useModelLogs(options: UseModelLogsOptions = {}) {
  return useQuery<ModelLogsResponse>({
    queryKey: ['modelLogs', options],
    queryFn: async () => {
      try {
        console.log('Fetching model logs with options:', options);
        const params = new URLSearchParams();
        if (options.startDate) params.append('startDate', options.startDate);
        if (options.endDate) params.append('endDate', options.endDate);
        if (options.model) params.append('model', options.model);
        if (options.search) params.append('search', options.search);

        const url = `/api/admin/model-logs?${params.toString()}`;
        console.log('Requesting URL:', url);

        const response = await api.get(url);
        console.log('Model logs response:', response.data);
        return response.data;
      } catch (error) {
        console.error('Error fetching model logs:', error);
        throw error;
      }
    },
  });
}
