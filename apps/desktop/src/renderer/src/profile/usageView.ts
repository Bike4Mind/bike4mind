import type { UsageBar, UsageGranularity, UsageWindowId } from '@shared/usage';

/** Trailing days each window covers, which is what a per-day rate has to be divided by. */
export const WINDOW_DAYS: Record<UsageWindowId, number> = {
  'last-24-hours': 1,
  'last-30-days': 30,
};

export const WINDOW_LABELS: Record<UsageWindowId, string> = {
  'last-24-hours': 'Last 24 Hours',
  'last-30-days': 'Last 30 Days',
};

const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const stampFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * The axis label for one bucket.
 *
 * Day buckets are UTC days on the server and are formatted in UTC for that reason: rendering
 * them locally would slide every label one day west of the bucket it names.
 */
export function bucketLabel(startsAt: string, granularity: UsageGranularity): string {
  const at = new Date(startsAt);
  if (granularity === 'day') return dayFormat.format(at);
  return String(at.getHours()).padStart(2, '0');
}

/** The full bucket description, for the hover. */
export function bucketTitle(startsAt: string, granularity: UsageGranularity): string {
  const at = new Date(startsAt);
  if (granularity === 'day') return dayFormat.format(at);
  return `${bucketLabel(startsAt, 'hour')}:00`;
}

/** Axis labels any window gets, whatever its bar count. A bar is narrower than its own label. */
const MAX_TICKS = 7;

/**
 * Which bars carry an axis label.
 *
 * Hours land on the quarter-day marks so the row reads as a clock rather than as an offset from
 * whenever the screen happened to be opened. Days have no such marks, so they are spaced back
 * from the NEWEST bar - today is the label a reader looks for first, and anchoring at the other
 * end is what leaves it missing.
 */
export function tickIndices(bars: readonly UsageBar[], granularity: UsageGranularity): number[] {
  if (granularity === 'hour') {
    return bars.reduce<number[]>((ticks, bar, index) => {
      if (new Date(bar.startsAt).getHours() % 6 === 0) ticks.push(index);
      return ticks;
    }, []);
  }

  const every = Math.max(1, Math.ceil(bars.length / MAX_TICKS));
  const ticks: number[] = [];
  for (let index = bars.length - 1; index >= 0; index -= every) ticks.push(index);
  return ticks.reverse();
}

/** Credits, grouped, and never rounded down to a zero that would read as "spent nothing". */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value === 0) return '0';
  if (value < 1) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value < 100) return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return Math.round(value).toLocaleString();
}

export function formatCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : '-';
}

/** Bar height as a percentage of the tallest bar. Zero stays zero so an empty hour draws none. */
export function barPercent(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

/**
 * Days the balance lasts at the window's own rate, or null when the question has no answer.
 *
 * Null rather than Infinity for a window that spent nothing: "runs out in forever" is not a
 * warning, and this figure exists to be one.
 */
export function runwayDays(balance: number | null, creditsSpent: number, days: number): number | null {
  if (balance === null || balance <= 0 || creditsSpent <= 0 || days <= 0) return null;
  return Math.floor(balance / (creditsSpent / days));
}

/** When the figures on screen were read. The answer is cached, so the screen says how old it is. */
export function formatReadAt(readAt: number): string {
  return stampFormat.format(new Date(readAt));
}

/** The billing period end, as a date rather than a timestamp. */
export function formatPeriodEnd(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '-';
  return at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
