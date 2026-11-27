import {
  SPEND_BASELINE_WINDOW,
  SPEND_EXPLORER_MAX_SERIES,
  SPEND_EXPLORER_OTHER_SERIES,
  SPEND_SPIKE_MIN_USD,
  SPEND_SPIKE_MULTIPLE,
  type SpendBucketSize,
  type SpendSplitDimension,
  type SpendTimelineBucket,
  type SpendTimelineRow,
} from '@bike4mind/common';

/**
 * Pure shaping for GET /api/admin/spend-explorer/timeline: turns the sparse
 * (bucket, key) rows from UsageEventRepository.spendTimeline into a dense,
 * chart-ready series with a rolling-median baseline and previous-period values.
 */

export const BUCKET_MS: Record<SpendBucketSize, number> = { hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 };

/** Floor a date to the start of its UTC bucket. */
export function floorToBucket(date: Date, bucket: SpendBucketSize): Date {
  const ms = BUCKET_MS[bucket];
  return new Date(Math.floor(date.getTime() / ms) * ms);
}

/** Ceil a date to the next UTC bucket boundary (a date on a boundary is unchanged). */
export function ceilToBucket(date: Date, bucket: SpendBucketSize): Date {
  const ms = BUCKET_MS[bucket];
  return new Date(Math.ceil(date.getTime() / ms) * ms);
}

/** The `$dateToString` key the aggregation emits for a bucket start (see spendExplorerPipelines). */
export function bucketKey(start: Date, bucket: SpendBucketSize): string {
  const iso = start.toISOString();
  return bucket === 'day' ? iso.slice(0, 10) : iso.slice(0, 13);
}

/**
 * The three providers worth telling apart on a bill: Anthropic and OpenAI invoice
 * directly, Bedrock arrives on the AWS bill. Everything else folds into `other`.
 */
const NAMED_PROVIDERS = new Set(['anthropic', 'openai', 'bedrock']);
export function normalizeProvider(provider: string): string {
  const lower = provider.toLowerCase();
  return NAMED_PROVIDERS.has(lower) ? lower : SPEND_EXPLORER_OTHER_SERIES;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** A zero baseline (brand-new or sporadic spend) flags any bucket at or above the floor. */
export function isSpike(totalUsd: number, baselineUsd: number): boolean {
  return totalUsd >= SPEND_SPIKE_MIN_USD && totalUsd > baselineUsd * SPEND_SPIKE_MULTIPLE;
}

/**
 * How far back the aggregation must reach so every bucket in [from, to) has a
 * full baseline window and a previous-period counterpart.
 */
export function lookbackStart(from: Date, to: Date, bucket: SpendBucketSize): Date {
  const rangeMs = to.getTime() - from.getTime();
  const baselineMs = SPEND_BASELINE_WINDOW[bucket] * BUCKET_MS[bucket];
  return new Date(from.getTime() - Math.max(rangeMs, baselineMs));
}

type ShapeInput = {
  rows: SpendTimelineRow[];
  from: Date;
  to: Date;
  bucket: SpendBucketSize;
  splitBy: SpendSplitDimension;
};

/** Series keys by total cost over the window, keeping the top ones and folding the rest into `other`. */
function pickSeries(costByKey: Map<string, number>): { kept: Set<string>; ordered: string[] } {
  const ranked = [...costByKey.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  if (ranked.length <= SPEND_EXPLORER_MAX_SERIES) return { kept: new Set(ranked), ordered: ranked };
  const kept = ranked.filter(k => k !== SPEND_EXPLORER_OTHER_SERIES).slice(0, SPEND_EXPLORER_MAX_SERIES - 1);
  return { kept: new Set(kept), ordered: [...kept, SPEND_EXPLORER_OTHER_SERIES] };
}

export function shapeTimeline({ rows, from, to, bucket, splitBy }: ShapeInput): {
  seriesKeys: string[];
  buckets: SpendTimelineBucket[];
} {
  const step = BUCKET_MS[bucket];
  const fromKey = bucketKey(from, bucket);
  const keyOf = (raw: string) => (splitBy === 'provider' ? normalizeProvider(raw) : raw);

  const totalByBucket = new Map<string, number>();
  const seriesByBucket = new Map<string, Map<string, number>>();
  const costByKey = new Map<string, number>();
  for (const row of rows) {
    totalByBucket.set(row.bucket, (totalByBucket.get(row.bucket) ?? 0) + row.costUsd);
    // Bucket keys are fixed-width, so string order is time order.
    if (row.bucket < fromKey) continue;
    const key = keyOf(row.key);
    costByKey.set(key, (costByKey.get(key) ?? 0) + row.costUsd);
    const series = seriesByBucket.get(row.bucket) ?? new Map<string, number>();
    series.set(key, (series.get(key) ?? 0) + row.costUsd);
    seriesByBucket.set(row.bucket, series);
  }

  const { kept, ordered } = pickSeries(costByKey);
  const totalAt = (ms: number) => totalByBucket.get(bucketKey(new Date(ms), bucket)) ?? 0;
  const rangeMs = to.getTime() - from.getTime();
  const window = SPEND_BASELINE_WINDOW[bucket];

  const buckets: SpendTimelineBucket[] = [];
  for (let ms = from.getTime(); ms < to.getTime(); ms += step) {
    const start = new Date(ms);
    const series: Record<string, number> = {};
    for (const [key, cost] of seriesByBucket.get(bucketKey(start, bucket)) ?? []) {
      const target = kept.has(key) ? key : SPEND_EXPLORER_OTHER_SERIES;
      series[target] = (series[target] ?? 0) + cost;
    }
    const totalUsd = totalAt(ms);
    const history = Array.from({ length: window }, (_, i) => totalAt(ms - (i + 1) * step));
    const baselineUsd = median(history);
    buckets.push({
      start: start.toISOString(),
      totalUsd,
      series,
      baselineUsd,
      isSpike: isSpike(totalUsd, baselineUsd),
      previousUsd: totalAt(ms - rangeMs),
    });
  }

  return { seriesKeys: ordered, buckets };
}
