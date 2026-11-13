import type { ChartRange } from './chartData';

/**
 * Calendar-day ranges for /status. The URL holds inclusive local days (YYYY-MM-DD); the API gets
 * the instants that bound them, so "Today" is the viewer's day. Server twin: server/qa/filters.ts.
 */

export interface DayRange {
  /** Inclusive local days, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface RangePreset {
  id: 'today' | '7d' | '30d' | '90d';
  label: string;
  days: number;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: 'Last 7 Days', days: 7 },
  { id: '30d', label: 'Last 30 Days', days: 30 },
  { id: '90d', label: 'Last 90 Days', days: 90 },
];

export const DEFAULT_RANGE_DAYS = 7;
/** Must stay within QA_MAX_RANGE_DAYS in server/qa/filters.ts. */
export const MAX_RANGE_DAYS = 366;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

export const toIsoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local midnight of a YYYY-MM-DD day, or null when it is not a real date. */
export function parseIsoDay(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DAY.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toIsoDay(d) === value ? d : null;
}

/** Calendar arithmetic, so DST days stay whole. */
export function addDays(day: string, n: number): string {
  const d = parseIsoDay(day) as Date;
  return toIsoDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/** Inclusive day count: a single day is 1. */
export function spanDays({ from, to }: DayRange): number {
  const a = parseIsoDay(from) as Date;
  const b = parseIsoDay(to) as Date;
  return (
    Math.round(
      (Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) /
        86_400_000
    ) + 1
  );
}

export function presetRange(days: number, now: Date = new Date()): DayRange {
  const to = toIsoDay(now);
  return { from: addDays(to, -(days - 1)), to };
}

/** Preset whose range matches exactly (ending today), if any. */
export function activePreset(range: DayRange, now: Date = new Date()): RangePreset | undefined {
  return RANGE_PRESETS.find(p => {
    const r = presetRange(p.days, now);
    return r.from === range.from && r.to === range.to;
  });
}

/**
 * The page's range: valid from/to as given, else the older `range=7d|30d` link, else the last 7 days.
 * Swapped days are put in order and an over-wide range keeps its end.
 */
export function resolveRange(
  search: { from?: string; to?: string; range?: '7d' | '30d' },
  now: Date = new Date()
): DayRange {
  const from = parseIsoDay(search.from);
  const to = parseIsoDay(search.to);
  if (!from || !to) return presetRange(search.range === '30d' ? 30 : DEFAULT_RANGE_DAYS, now);
  const ordered =
    from <= to
      ? { from: search.from as string, to: search.to as string }
      : { from: search.to as string, to: search.from as string };
  return spanDays(ordered) > MAX_RANGE_DAYS
    ? { from: addDays(ordered.to, -(MAX_RANGE_DAYS - 1)), to: ordered.to }
    : ordered;
}

/** API bounds: local midnight of `from` to local midnight after `to`. */
export function rangeInstants(range: DayRange): { from: string; to: string } {
  return {
    from: (parseIsoDay(range.from) as Date).toISOString(),
    to: (parseIsoDay(addDays(range.to, 1)) as Date).toISOString(),
  };
}

/** Over a week, charts plot one bucket per day; up to a week, one point per run. */
export const chartRangeFor = (range: DayRange): ChartRange => (spanDays(range) > DEFAULT_RANGE_DAYS ? '30d' : '7d');
