import type { AnalyticsBucket } from '@client/app/utils/analyticsOverview';

const utcDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** "Jun 14" (or "Jun 2026" for a month bucket), always in UTC. */
export function formatDayLabel(day: string, bucket: AnalyticsBucket = 'day'): string {
  return utcDate(day).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    ...(bucket === 'month' ? { year: 'numeric' } : { day: 'numeric' }),
  });
}

/** "04:10 UTC" when `iso` is today (UTC), else "Jun 14, 04:10 UTC". */
export function formatUpdatedAt(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? `${time} UTC` : `${formatDayLabel(date.toISOString().slice(0, 10))}, ${time} UTC`;
}

export const formatCount = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : Math.round(value).toLocaleString('en-US');

export const formatPercent = (value: number | null | undefined) =>
  value === null || value === undefined ? '-' : `${value.toFixed(1)}%`;

/**
 * The tile's comparison line, signed and neutral: "+12% vs previous 27 days". Stickiness is already
 * a percent, so it compares in points.
 */
export function comparisonLine(
  value: number | null,
  previous: number | null,
  days: number,
  unit: 'relative' | 'points' = 'relative'
): string {
  const period = `previous ${days} ${days === 1 ? 'day' : 'days'}`;
  if (value === null || previous === null) return `No data to compare with the ${period}`;
  if (unit === 'points') {
    const delta = value - previous;
    return `${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(1)} pts vs ${period}`;
  }
  if (previous === 0) return value === 0 ? `No change vs ${period}` : `Up from 0 vs ${period}`;
  const delta = Math.round(((value - previous) / previous) * 100);
  return `${delta >= 0 ? '+' : '-'}${Math.abs(delta)}% vs ${period}`;
}

/** At most `points` averaged values for a StatSparkline; gaps are skipped rather than drawn as zero. */
export function sparklineValues(values: readonly (number | null)[], points = 28): number[] {
  const present = values.filter((value): value is number => value !== null);
  if (present.length <= points) return present;
  const size = present.length / points;
  return Array.from({ length: points }, (_, index) => {
    const chunk = present.slice(Math.floor(index * size), Math.floor((index + 1) * size));
    return chunk.reduce((total, value) => total + value, 0) / chunk.length;
  });
}
