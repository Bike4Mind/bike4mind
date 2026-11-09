import dayjs from 'dayjs';

// The page has no free-text search; query and view are declared only because the list URL state needs them.
export const MODEL_METRICS_SEARCH_KEYS = {
  query: 'metricsQuery',
  view: 'metricsView',
  filters: { period: 'metricsPeriod', model: 'metricsModel', status: 'metricsStatus' },
} as const;
export const MODEL_METRICS_TAB_PARAMS = Object.values(MODEL_METRICS_SEARCH_KEYS.filters);

export const PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
] as const;

export const STATUS_OPTIONS = [
  { value: 'done', label: 'Done' },
  { value: 'error', label: 'Error' },
  { value: 'pending', label: 'Pending' },
] as const;

const PERIOD_HOURS: Record<string, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };

/** An unset or unknown period means no date bounds. */
export function resolvePeriod(period: string, now: dayjs.Dayjs): { dateFrom?: string; dateTo?: string } {
  // No dateTo on the rolling presets and end of day on Today, so Refresh still picks up calls made after the pick.
  if (period === 'today') return { dateFrom: now.startOf('day').toISOString(), dateTo: now.endOf('day').toISOString() };
  const hours = PERIOD_HOURS[period];
  return hours ? { dateFrom: now.subtract(hours, 'hour').toISOString() } : {};
}
