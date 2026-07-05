import type { CompletionSource } from '@bike4mind/common';

export interface KpiMetrics {
  last24h: number;
  weeklyTotal: number;
  lastWeekTotal: number;
  monthlyTotal: number;
  lastMonthTotal: number;
  weekOverWeekChange: number;
  monthOverMonthChange: number;
  fourWeekAverage: number;
  fourWeekAverageChange: number;
}

export interface ModelUsageMetrics {
  modelName: string;
  count: number;
  rankChange?: 'up' | 'down' | 'new' | 'same';
  lastWeekRank?: number | 'new' | '>#10';
}

export interface UserActivityMetrics {
  totalUniqueUsers: number;
  internalUsers: number;
  externalUsers: number;
  topUsers: Array<{
    _id?: string;
    email: string;
    interactions: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#20';
  }>;
  topModels: ModelUsageMetrics[];
}

export interface CounterLog {
  date: string;
  counterName: string;
  totalValue: number;
  count: number;
  userId: string;
  userEmail: string;
}

export interface CounterMetricsResponse {
  logs: CounterLog[];
  metrics: Record<string, KpiMetrics>;
  userActivity: UserActivityMetrics;
  peakDay?: {
    date: string;
    totalEvents: number;
  };
  peakTime?: {
    hour: number;
    avgEvents: number;
  };
  lastWeekPeakDay?: {
    date: string;
    totalEvents: number;
  };
  lastWeekPeakTime?: {
    hour: number;
    avgEvents: number;
  };
  topOrganizations?: Array<{
    name: string;
    events: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#10';
  }>;
  usageBySource?: Array<{ source: CompletionSource; count: number }>;
  nextWeekFocus?: string[];
}

export type EventName = keyof CounterMetricsResponse['metrics'];

// Weekly report data interface for formatting reports
export interface WeeklyReportData {
  weekStart: string;
  weekEnd: string;
  metrics: Record<string, KpiMetrics>;
  userActivity: UserActivityMetrics;
  aiInsights?: string | string[] | null;
  peakDay?: {
    date: string;
    totalEvents: number;
  };
  peakTime?: {
    hour: number;
    avgEvents: number;
  };
  lastWeekPeakDay?: {
    date: string;
    totalEvents: number;
  };
  lastWeekPeakTime?: {
    hour: number;
    avgEvents: number;
  };
  topOrganizations?: Array<{
    name: string;
    events: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#10';
  }>;
  usageBySource?: Array<{ source: CompletionSource; count: number }>;
}
