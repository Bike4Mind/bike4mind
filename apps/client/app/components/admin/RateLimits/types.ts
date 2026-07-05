import type { RateLimitIntegrationType } from '@bike4mind/common';

export interface RateLimitSnapshot {
  _id: string;
  integration: RateLimitIntegrationType;
  userId: string;
  endpoint: string;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  usagePercent: number | null;
  wasThrottled: boolean;
  retryAfterMs: number | null;
  timestamp: string;
}

export interface RateLimitFilters {
  dateFrom?: string;
  dateTo?: string;
  integration?: string;
  throttledOnly?: boolean;
}

export interface UsageTimeSeriesPoint {
  date: string;
  github: number;
  jira: number;
  confluence: number;
  slack: number;
}

export interface ThrottledByDay {
  date: string;
  count: number;
  integration: string;
}

export interface IntegrationSummary {
  integration: string;
  totalSnapshots: number;
  throttledCount: number;
  avgUsagePercent: number;
  latestRemaining: number | null;
  latestLimit: number | null;
  latestResetAt: string | null;
}

export interface ChartData {
  usageTimeSeries: UsageTimeSeriesPoint[];
  throttledByDay: ThrottledByDay[];
  integrationSummaries: IntegrationSummary[];
}
