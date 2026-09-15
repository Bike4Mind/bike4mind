import { RATE_LIMIT_INTEGRATIONS } from '@bike4mind/common';
import type { RateLimitSnapshot, ChartData, UsageTimeSeriesPoint, ThrottledByDay, IntegrationSummary } from '../types';

function formatDate(timestamp: string): string {
  return new Date(timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit' });
}

function formatDayKey(timestamp: string): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function processChartData(snapshots: RateLimitSnapshot[]): ChartData {
  // Usage time series: group by hour, average usagePercent per integration
  const hourBuckets = new Map<string, { github: number[]; jira: number[]; confluence: number[]; slack: number[] }>();

  for (const snap of snapshots) {
    const hourKey = new Date(snap.timestamp).toISOString().slice(0, 13);
    if (!hourBuckets.has(hourKey)) {
      hourBuckets.set(hourKey, { github: [], jira: [], confluence: [], slack: [] });
    }
    const bucket = hourBuckets.get(hourKey)!;
    if (snap.usagePercent !== null) {
      bucket[snap.integration as keyof typeof bucket].push(snap.usagePercent);
    }
  }

  const usageTimeSeries: UsageTimeSeriesPoint[] = Array.from(hourBuckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hourKey, bucket]) => ({
      date: formatDate(hourKey + ':00:00Z'),
      github: bucket.github.length ? Math.round(bucket.github.reduce((a, b) => a + b, 0) / bucket.github.length) : 0,
      jira: bucket.jira.length ? Math.round(bucket.jira.reduce((a, b) => a + b, 0) / bucket.jira.length) : 0,
      confluence: bucket.confluence.length
        ? Math.round(bucket.confluence.reduce((a, b) => a + b, 0) / bucket.confluence.length)
        : 0,
      slack: bucket.slack.length ? Math.round(bucket.slack.reduce((a, b) => a + b, 0) / bucket.slack.length) : 0,
    }));

  // Throttled events by day
  const throttledMap = new Map<string, Map<string, number>>();
  for (const snap of snapshots.filter(s => s.wasThrottled)) {
    const dayKey = formatDayKey(snap.timestamp);
    if (!throttledMap.has(dayKey)) throttledMap.set(dayKey, new Map());
    const dayBucket = throttledMap.get(dayKey)!;
    dayBucket.set(snap.integration, (dayBucket.get(snap.integration) || 0) + 1);
  }

  const throttledByDay: ThrottledByDay[] = [];
  for (const [day, integrations] of Array.from(throttledMap.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [integration, count] of integrations) {
      throttledByDay.push({ date: day, integration, count });
    }
  }

  // Per-integration summaries
  const integrationSummaries: IntegrationSummary[] = RATE_LIMIT_INTEGRATIONS.map(integration => {
    const filtered = snapshots.filter(s => s.integration === integration);
    const throttled = filtered.filter(s => s.wasThrottled);
    const withUsage = filtered.filter(s => s.usagePercent !== null);
    const latest = filtered[0]; // Already sorted desc by timestamp from API

    return {
      integration,
      totalSnapshots: filtered.length,
      throttledCount: throttled.length,
      avgUsagePercent: withUsage.length
        ? Math.round(withUsage.reduce((sum, s) => sum + (s.usagePercent ?? 0), 0) / withUsage.length)
        : 0,
      latestRemaining: latest?.remaining ?? null,
      latestLimit: latest?.limit ?? null,
      latestResetAt: latest?.resetAt ?? null,
    };
  });

  return { usageTimeSeries, throttledByDay, integrationSummaries };
}
