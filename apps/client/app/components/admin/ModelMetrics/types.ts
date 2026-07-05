export interface ModelMetric {
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
  /** Per-stage request lifecycle log, for the status-log timeline. */
  statusLog?: Array<{ status: string; timestamp: string }>;
}

export type SortField =
  | 'timestamp'
  | 'model'
  | 'inputTokens'
  | 'outputTokens'
  | 'creditsUsed'
  | 'responseTime'
  | 'contextTime'
  | 'status';

export type SortDirection = 'asc' | 'desc';

export interface ChartData {
  modelUsageData: Array<{
    id: string;
    label: string;
    value: number;
    percentage: string;
  }>;
  performanceData: Array<{
    model: string;
    avgResponseTime: number;
    count: number;
  }>;
  dailyTrends: Array<{
    id: string;
    data: Array<{
      x: string;
      y: number;
    }>;
  }>;
  contextRetrievalTrends: Array<{
    id: string;
    data: Array<{
      x: string;
      y: number;
    }>;
  }>;
  firstTokenTrends: Array<{
    id: string;
    data: Array<{
      x: string;
      y: number;
    }>;
  }>;
  charactersPerSecondTrends: Array<{
    id: string;
    data: Array<{
      x: string;
      y: number;
    }>;
  }>;
  processPickupTrends: Array<{
    id: string;
    data: Array<{
      x: string;
      y: number;
    }>;
  }>;
}
