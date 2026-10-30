import { type ISpendRollup, SPEND_BUCKET_MS } from '@bike4mind/common';

const WINDOW_MS = 3 * SPEND_BUCKET_MS;
const DAY_MS = 24 * 60 * 60 * 1000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Nearest-rank percentile; `p` is 0-100. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p * sorted.length) / 100));
  return sorted[rank - 1];
}

/**
 * Sums of every consecutive non-overlapping 15-minute window ending at `windowEnd`, going back `days`.
 * Windows are [start, end); buckets absent from the series count as 0. Newest window first.
 */
export function windowSums(
  series: ISpendRollup[],
  windowEnd: Date,
  days: number,
  field: 'credits' | 'costUsd'
): number[] {
  const windowCount = Math.floor((days * DAY_MS) / WINDOW_MS);
  const sums = new Array<number>(windowCount).fill(0);
  const endMs = windowEnd.getTime();
  const earliestMs = endMs - windowCount * WINDOW_MS;

  for (const rollup of series) {
    const bucketMs = rollup.bucketStart.getTime();
    if (bucketMs < earliestMs || bucketMs >= endMs) continue;
    const windowIndex = Math.floor((endMs - 1 - bucketMs) / WINDOW_MS);
    sums[windowIndex] += rollup[field];
  }
  return sums;
}

/** Same-time-of-day history when it has at least 2 samples, else the trailing 24h, else no baseline. */
export function platformBaseline(sameSlotSamples: number[], trailing24hWindowSums: number[]): number | null {
  if (sameSlotSamples.length >= 2) return median(sameSlotSamples);
  return median(trailing24hWindowSums);
}

export function scopeBaseline(sevenDayWindowSums: number[]): number {
  return percentile(sevenDayWindowSums, 95) ?? 0;
}
