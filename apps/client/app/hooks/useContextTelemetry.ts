import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type {
  ContextTelemetry,
  AnomalySeverity,
  PrimaryAnomaly,
  HistoricalBaselines,
  RecommendedAction,
} from '@bike4mind/common';

export type { HistoricalBaselines };

// Analysis response from the analyze endpoint
export interface TelemetryAnalysis {
  summary: string;
  findings: string[];
  recommendations: string[];
  severity: string;
  estimatedImpact: string;
  recommendedAction?: RecommendedAction;
}

export interface AnalyzeResponse {
  id: string;
  timestamp: string;
  analysis: TelemetryAnalysis;
  analysisSource?: 'llm' | 'rule-based';
  historicalBaselines?: HistoricalBaselines | null;
  cached?: boolean;
  cachedAt?: string;
  telemetrySummary: {
    anomalyScore: number;
    primaryAnomaly: string;
    model: string;
    provider: string;
    inputTokens: number;
    utilizationPercent: number;
    responseTimeMs: number;
  };
}

// GitHub issue response from create-issue endpoint
export interface CreateIssueResponse {
  success: boolean;
  issue: {
    number: number;
    url: string;
    title: string;
    state: string;
    labels: string[];
  };
  telemetryId: string;
}

export interface ContextTelemetryEntry {
  id: string;
  timestamp: string;
  telemetry: ContextTelemetry | null;
}

export interface ContextTelemetryStats {
  totalEntries: number;
  avgAnomalyScore: number;
  avgUtilization: number;
  avgResponseTimeMs: number;
  providers: string[];
  models: string[];
  severityDistribution: Record<string, number>;
}

export interface ContextTelemetryResponse {
  entries: ContextTelemetryEntry[];
  total: number;
  offset: number;
  limit: number;
  stats: ContextTelemetryStats;
}

export interface UseContextTelemetryOptions {
  startDate?: string;
  endDate?: string;
  modelId?: string;
  provider?: string;
  minAnomalyScore?: number;
  severity?: AnomalySeverity;
  anomalyType?: PrimaryAnomaly;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

export function useContextTelemetry(options: UseContextTelemetryOptions = {}) {
  const { enabled = true, ...queryOptions } = options;

  return useQuery<ContextTelemetryResponse>({
    queryKey: ['contextTelemetry', queryOptions],
    queryFn: async () => {
      const params = new URLSearchParams();

      if (queryOptions.startDate) params.append('startDate', queryOptions.startDate);
      if (queryOptions.endDate) params.append('endDate', queryOptions.endDate);
      if (queryOptions.modelId) params.append('modelId', queryOptions.modelId);
      if (queryOptions.provider) params.append('provider', queryOptions.provider);
      if (queryOptions.minAnomalyScore !== undefined) {
        params.append('minAnomalyScore', queryOptions.minAnomalyScore.toString());
      }
      if (queryOptions.severity) params.append('severity', queryOptions.severity);
      if (queryOptions.anomalyType) params.append('anomalyType', queryOptions.anomalyType);
      if (queryOptions.limit) params.append('limit', queryOptions.limit.toString());
      if (queryOptions.offset) params.append('offset', queryOptions.offset.toString());

      const response = await api.get(`/api/admin/context-telemetry?${params.toString()}`);
      return response.data;
    },
    enabled,
    staleTime: 30_000, // 30 seconds
  });
}

/**
 * Hook to analyze telemetry anomalies for a specific entry
 */
export function useAnalyzeTelemetry() {
  return useMutation<AnalyzeResponse, Error, { id: string; force?: boolean }>({
    mutationFn: async ({ id, force }) => {
      const params = force ? '?force=true' : '';
      const response = await api.post(`/api/admin/context-telemetry/${id}/analyze${params}`);
      return response.data;
    },
  });
}

/**
 * Hook to create a GitHub issue from telemetry data
 */
export function useCreateTelemetryIssue() {
  return useMutation<CreateIssueResponse, Error, { id: string; repository: string; additionalContext?: string }>({
    mutationFn: async ({ id, repository, additionalContext }) => {
      const response = await api.post(`/api/admin/context-telemetry/${id}/create-issue`, {
        repository,
        additionalContext,
      });
      return response.data;
    },
  });
}

// Health check types
export interface HealthCheckItem {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

export interface IntegrationHealthResponse {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheckItem[];
  github: boolean;
  slack: boolean;
  llm: boolean;
}

/**
 * Hook to check integration status (GitHub token availability)
 */
export function useIntegrationStatus() {
  return useQuery<IntegrationHealthResponse>({
    queryKey: ['integrationStatus'],
    queryFn: async () => {
      const response = await api.get('/api/admin/context-telemetry/integration-status');
      return response.data;
    },
    staleTime: 60_000, // 1 minute
  });
}

// Dry Run types
export type DryRunSource = 'test' | 'real';
export type DryRunPriority = 'P0' | 'P1' | 'P2' | 'P3';

export interface DryRunTelemetrySummary {
  anomalyScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  primaryAnomaly: string;
  modelId: string;
  provider: string;
}

export interface DryRunAction {
  wouldCreateIssue: boolean;
  issueTitle?: string;
  priority: DryRunPriority;
  labels: string[];
  isRegression: boolean;
  regressedFromIssue?: number;
  isDuplicate: boolean;
  matchedIssueNumber?: number;
  wouldSendSlackAlert: boolean;
  slackChannelId?: string;
}

export interface DryRunResult {
  _id: string;
  timestamp: string;
  source: DryRunSource;
  questId?: string;
  telemetrySummary: DryRunTelemetrySummary;
  action: DryRunAction;
  fingerprint: string;
  semanticFingerprint: string;
  expiresAt: string;
}

export interface DryRunResultsResponse {
  results: DryRunResult[];
  total: number;
}

export interface UseDryRunResultsOptions {
  limit?: number;
  source?: DryRunSource | 'all';
  enabled?: boolean;
}

/**
 * Hook to fetch dry run results
 */
export function useDryRunResults(options: UseDryRunResultsOptions = {}) {
  const { enabled = true, ...queryOptions } = options;

  return useQuery<DryRunResultsResponse>({
    queryKey: ['dryRunResults', queryOptions],
    queryFn: async () => {
      const params = new URLSearchParams();

      if (queryOptions.limit) params.append('limit', queryOptions.limit.toString());
      if (queryOptions.source && queryOptions.source !== 'all') {
        params.append('source', queryOptions.source);
      }

      const response = await api.get(`/api/admin/context-telemetry/dry-run-results?${params.toString()}`);
      return response.data;
    },
    enabled,
    staleTime: 10_000, // 10 seconds - more frequent refresh for dry run results
    refetchInterval: 30_000, // Auto-refresh every 30 seconds when enabled
  });
}

export interface TestConfigRequest {
  useSample?: boolean;
  sampleType?: 'critical' | 'high' | 'medium' | 'low';
  telemetryEntryId?: string;
}

export interface TestConfigResponse {
  result: DryRunResult;
}

/**
 * Hook to trigger a test configuration with sample or real telemetry data
 */
export function useTestConfig() {
  return useMutation<TestConfigResponse, Error, TestConfigRequest>({
    mutationFn: async (request: TestConfigRequest) => {
      const response = await api.post('/api/admin/context-telemetry/test-config', request);
      return response.data;
    },
  });
}
