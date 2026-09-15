import type { HealthCheckHistoryPoint, LatencyTimePoint, ErrorRatePoint } from '../types';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function bucketKey(dateStr: string, bucketMinutes: number): string {
  const d = new Date(dateStr);
  const mins = d.getMinutes();
  d.setMinutes(mins - (mins % bucketMinutes), 0, 0);
  return d.toISOString();
}

function formatBucketLabel(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function buildLatencyTimeSeries(checks: HealthCheckHistoryPoint[], bucketMinutes = 30): LatencyTimePoint[] {
  const buckets = new Map<string, number[]>();

  for (const check of checks) {
    const key = bucketKey(check.checkedAt, bucketMinutes);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(check.latencyMs);
  }

  // Sort by ISO key (chronological), then format labels for display
  const sortedKeys = [...buckets.keys()].sort();
  return sortedKeys.map(key => {
    const latencies = buckets.get(key)!;
    const sorted = latencies.slice().sort((a, b) => a - b);
    return {
      time: formatBucketLabel(key),
      p50: Math.round(percentile(sorted, 0.5)),
      p95: Math.round(percentile(sorted, 0.95)),
    };
  });
}

export function buildErrorRateSeries(checks: HealthCheckHistoryPoint[], bucketMinutes = 60): ErrorRatePoint[] {
  const buckets = new Map<string, { failures: number; total: number }>();

  for (const check of checks) {
    const key = bucketKey(check.checkedAt, bucketMinutes);
    if (!buckets.has(key)) buckets.set(key, { failures: 0, total: 0 });
    const bucket = buckets.get(key)!;
    bucket.total++;
    if (check.status === 'unhealthy') bucket.failures++;
  }

  // Sort by ISO key (chronological), then format labels for display
  const sortedKeys = [...buckets.keys()].sort();
  return sortedKeys.map(key => {
    const data = buckets.get(key)!;
    return {
      time: formatBucketLabel(key),
      failures: data.failures,
      total: data.total,
    };
  });
}
