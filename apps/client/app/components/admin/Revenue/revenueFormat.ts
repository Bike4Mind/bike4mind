import type { RevenueTrendPoint } from '@client/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@client/app/utils/adminSubscriptionsFilter';
import { formatMoney } from '../shared/formatMoney';

// Snapshot days are UTC calendar days, so they are shown in UTC whatever the browser's zone.
const dayOf = (day: string) => new Date(`${day}T00:00:00Z`);

export const formatTrendDay = (day: string): string =>
  dayOf(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export const formatLongDay = (day: string): string =>
  dayOf(day).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function signedMoney(minorUnits: number): string {
  if (minorUnits === 0) return 'No change';
  const formatted = formatMoney(minorUnits, MRR_CURRENCY);
  return minorUnits > 0 ? `+${formatted}` : formatted;
}

/** "<1%" for a nonzero share that would round to 0%. */
export function formatShare(share: number | null): string | null {
  if (share === null) return null;
  if (share > 0 && share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}

export function trendTakeaway(points: readonly RevenueTrendPoint[]): string {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return '';
  const now = `${formatMoney(last.mrr, MRR_CURRENCY)} MRR from ${last.payingCount.toLocaleString()} paying`;
  if (points.length === 1) return `One snapshot so far (${formatTrendDay(first.date)}): ${now}.`;
  const since = formatTrendDay(first.date);
  if (last.mrr === first.mrr) return `MRR is flat since ${since}: ${now}.`;
  const direction = last.mrr > first.mrr ? 'up' : 'down';
  const change =
    first.mrr > 0
      ? `${Math.abs(((last.mrr - first.mrr) / first.mrr) * 100).toFixed(1)}%`
      : formatMoney(Math.abs(last.mrr - first.mrr), MRR_CURRENCY);
  return `MRR is ${direction} ${change} since ${since}: ${now}.`;
}
