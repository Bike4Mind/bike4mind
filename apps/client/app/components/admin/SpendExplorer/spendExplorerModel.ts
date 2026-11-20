import { formatMoney } from '../shared/formatMoney';
import type { SpendAccountsResponse, SpendBucketSize, SpendTimelineBucket } from '@bike4mind/common';

/**
 * Pure view-model helpers for the Spend explorer: range presets, KPIs and the
 * plain-text summary. All times are UTC, matching the server's buckets.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export const RANGE_PRESETS = [7, 14, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const DEFAULT_PRESET: RangePreset = 14;

/** Mirrors HOURLY_AUTO_MAX_DAYS on the server (server/admin/spendExplorer/query.ts). */
export const HOURLY_MAX_DAYS = 3;

export type SpendRange = { from: Date; to: Date };

const startOfUtcDay = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** The last `days` whole UTC days, today included (today is partial). */
export function presetRange(days: number, now: Date = new Date()): SpendRange {
  const to = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

/** A custom range from two `YYYY-MM-DD` dates, both days inclusive. */
export function customRange(fromDay: string, toDay: string): SpendRange | null {
  const from = new Date(`${fromDay}T00:00:00Z`);
  const lastDay = new Date(`${toDay}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(lastDay.getTime()) || lastDay < from) return null;
  return { from, to: new Date(lastDay.getTime() + DAY_MS) };
}

export const bucketForRange = (range: SpendRange): SpendBucketSize =>
  range.to.getTime() - range.from.getTime() <= HOURLY_MAX_DAYS * DAY_MS ? 'hour' : 'day';

export const bucketMs = (bucket: SpendBucketSize) => (bucket === 'hour' ? HOUR_MS : DAY_MS);

export const toDayInput = (date: Date) => date.toISOString().slice(0, 10);

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export type SpendKpis = {
  totalUsd: number;
  medianUsd: number;
  peak: SpendTimelineBucket | null;
  top5Share: number | null;
};

export function computeKpis(buckets: SpendTimelineBucket[], accounts: SpendAccountsResponse | undefined): SpendKpis {
  const peak = buckets.reduce<SpendTimelineBucket | null>(
    (best, bucket) => (bucket.totalUsd > (best?.totalUsd ?? 0) ? bucket : best),
    null
  );
  const top5 = accounts?.accounts.slice(0, 5).reduce((sum, a) => sum + a.costUsd, 0);
  return {
    totalUsd: buckets.reduce((sum, b) => sum + b.totalUsd, 0),
    medianUsd: median(buckets.map(b => b.totalUsd)),
    peak,
    top5Share: accounts && accounts.totalCostUsd > 0 && top5 !== undefined ? top5 / accounts.totalCostUsd : null,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 11" for a day bucket, "Nov 11 14:00" for an hour bucket (UTC). */
export function formatBucket(startIso: string, bucket: SpendBucketSize): string {
  const date = new Date(startIso);
  const day = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return bucket === 'hour' ? `${day} ${String(date.getUTCHours()).padStart(2, '0')}:00` : day;
}

/** "Nov 10-17" or "Oct 28-Nov 3" for a range, naming the last whole day it covers. */
export function formatRange(range: SpendRange): string {
  const last = new Date(range.to.getTime() - 1);
  const fromMonth = MONTHS[range.from.getUTCMonth()];
  const lastMonth = MONTHS[last.getUTCMonth()];
  const tail = fromMonth === lastMonth ? `${last.getUTCDate()}` : `${lastMonth} ${last.getUTCDate()}`;
  return `${fromMonth} ${range.from.getUTCDate()}-${tail}`;
}

/** USD amounts arrive as dollars (UsageEvent.costUsd); the admin formatter takes cents. */
export const formatUsd = (value: number, options?: { compact?: boolean }) =>
  formatMoney(Math.round(value * 100), 'usd', options);

export const formatShare = (share: number) => `${Math.round(share * 100)}%`;

/** Bucket cost over its baseline, or null when there is no baseline to compare with. */
export const multipleOfBaseline = (bucket: SpendTimelineBucket): number | null =>
  bucket.baselineUsd > 0 ? bucket.totalUsd / bucket.baselineUsd : null;

/** Plain-text summary for pasting into Slack. ASCII only, no markup. */
export function buildSlackSummary(params: {
  range: SpendRange;
  bucket: SpendBucketSize;
  buckets: SpendTimelineBucket[];
  accounts: SpendAccountsResponse | undefined;
}): string {
  const { range, bucket, buckets, accounts } = params;
  const kpis = computeKpis(buckets, accounts);
  const parts = [`${formatRange(range)} (UTC): B4M recorded ${formatUsd(kpis.totalUsd)} of AI provider cost`];
  if (kpis.peak) {
    const multiple = multipleOfBaseline(kpis.peak);
    const vs = multiple === null ? '' : ` (${multiple.toFixed(1)}x median)`;
    parts.push(`peak ${formatBucket(kpis.peak.start, bucket)} ${formatUsd(kpis.peak.totalUsd)}${vs}`);
  }
  const spikes = buckets.filter(b => b.isSpike).length;
  if (spikes > 0) parts.push(`${spikes} spike ${bucket === 'hour' ? 'hour' : 'day'}${spikes === 1 ? '' : 's'}`);
  const top = accounts?.accounts.slice(0, 3) ?? [];
  if (top.length > 0) {
    parts.push(
      `top spenders: ${top.map(a => `${a.name} ${formatUsd(a.costUsd)} (${formatShare(a.share)})`).join(', ')}`
    );
  }
  return `${parts.join('; ')}.`;
}
