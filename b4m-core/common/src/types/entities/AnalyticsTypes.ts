import type { CompletionSource } from '../analytics';

export interface FacetResults {
  last24h?: Array<{ _id: string; count: number }>;
  thisWeek?: Array<{ _id: string; count: number }>;
  lastWeek?: Array<{ _id: string; count: number }>;
  thisMonth?: Array<{ _id: string; count: number }>;
  lastMonth?: Array<{ _id: string; count: number }>;
  allUsers?: Array<{ count: number }>;
  internalUsers?: Array<{ count: number }>;
  topUsers?: Array<{
    _id: string;
    email: string;
    interactions: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#20';
  }>;
  topModels?: Array<{
    modelName: string;
    count: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#10';
  }>;
  topOrganizations?: Array<{
    name: string;
    events: number;
    rankChange?: 'up' | 'down' | 'new' | 'same';
    lastWeekRank?: number | 'new' | '>#10';
  }>;
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
  /**
   * Counter-log events grouped by `metadata.source` (web/cli/api/agent/system)
   * for the current period. Drives the "Usage by Source" line in the daily/
   * weekly report. Empty when no events carry `metadata.source` yet (pre-
   * instrumentation history).
   */
  usageBySource?: Array<{ _id: CompletionSource; count: number }>;
  hasData?: boolean;
}
