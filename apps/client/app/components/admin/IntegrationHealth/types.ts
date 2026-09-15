export type TimeRange = '24h' | '7d' | '30d';

// These types mirror server-side definitions from @bike4mind/database - keep in sync
export type IntegrationName = 'slack' | 'github' | 'jira' | 'confluence';

export type IntegrationHealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export type CircuitBreakerMode = 'auto' | 'force_block' | 'force_open';

export interface CircuitBreakerStatus {
  available: boolean;
  reason: string | null;
  mode: CircuitBreakerMode;
  autoTripped: boolean;
  noData?: boolean;
  allConfigMissing?: boolean;
}

export interface RateLimitSummary {
  limit: number | null;
  remaining: number | null;
  usagePercent: number | null;
  resetAt: string | null;
  wasThrottled: boolean;
}

export interface RecentError {
  source: 'health_check' | 'audit_log';
  occurredAt: string;
  message: string;
  errorCode: string | null;
  entityType: string | null;
  action: string | null;
}

export interface IntegrationDashboardEntry {
  name: IntegrationName;
  status: IntegrationHealthStatus;
  latencyMs: number;
  lastCheckedAt: string;
  successRate: number;
  consecutiveFailures: number;
  error: string | null;
  circuitBreaker: CircuitBreakerStatus;
  rateLimit: RateLimitSummary | null;
  recentErrors: RecentError[];
}

// Mirrors CircuitBreakerSnapshot from @bike4mind/utils - keep in sync
export interface InMemoryBreakerState {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  halfOpenSuccessCount: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  nextRetryTime: number | null;
  halfOpenActiveCount: number;
  totalCalls: number;
  failureRate: number | null;
}

export interface IntegrationDashboardResponse {
  generatedAt: string;
  timeRangeHours: number;
  integrations: IntegrationDashboardEntry[];
  inMemoryBreakerStates: Record<string, InMemoryBreakerState>;
}

export interface HealthCheckHistoryPoint {
  status: IntegrationHealthStatus;
  latencyMs: number;
  statusCode: number | null;
  error: string | null;
  checkedAt: string;
  metadata: {
    rateLimitRemaining?: number;
    rateLimitLimit?: number;
    rateLimitReset?: number;
  };
}

export interface IntegrationHistoryResponse {
  integration: IntegrationName;
  checks: HealthCheckHistoryPoint[];
}

export interface LatencyTimePoint {
  time: string;
  p50: number;
  p95: number;
}

export interface ErrorRatePoint {
  time: string;
  failures: number;
  total: number;
}
