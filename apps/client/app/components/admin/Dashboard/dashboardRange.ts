import type { SpendData, SpendKpi } from '@bike4mind/common';

export type DashboardRange = '7d' | '28d';

export const DASHBOARD_RANGE_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '28d', label: '28 days' },
] as const;

export const RANGE_DAYS: Record<DashboardRange, number> = { '7d': 7, '28d': 28 };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The spend window ending now, rounded down to the hour so the query key (and the server's 12h
 * response cache) stay stable while the page is open. The server derives the prior window itself.
 */
export function spendWindow(range: DashboardRange, now = Date.now()): { dateFrom: string; dateTo: string } {
  const to = Math.floor(now / HOUR_MS) * HOUR_MS;
  return { dateFrom: new Date(to - RANGE_DAYS[range] * DAY_MS).toISOString(), dateTo: new Date(to).toISOString() };
}

export const spendKpi = (data: SpendData | undefined, key: SpendKpi['key']): SpendKpi | undefined =>
  data?.kpis.find(kpi => kpi.key === key);
