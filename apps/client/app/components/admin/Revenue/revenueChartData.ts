import type { RevenueRange, RevenueTrendPlan, RevenueTrendPoint } from '@bike4mind/server-utils/app/utils/adminRevenue';
import { MRR_CURRENCY } from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import { formatMoney } from '../shared/formatMoney';
import { formatShare, formatTrendDay, signedMoney } from './revenueFormat';

/** Chart data for the Revenue page (docs/admin-subscriptions-spec.md 5.7), derived from the daily snapshot trend. */

export type PeriodUnit = 'day' | 'week' | 'month';

// Bars stay readable: about 30 in each range.
export const PERIOD_UNIT: Readonly<Record<RevenueRange, PeriodUnit>> = { '30d': 'day', '90d': 'week', '12m': 'month' };

export type RevenuePeriod = {
  /** First UTC day of the period, `YYYY-MM-DD`. */
  start: string;
  label: string;
  /** Summed over the period's snapshots. */
  newMrr: number;
  churnedMrr: number;
  net: number;
  /** As of the period's last snapshot. */
  payingUsers: number;
  payingOrgs: number;
};

const dayOf = (day: string) => new Date(`${day}T00:00:00Z`);

export function periodStart(day: string, unit: PeriodUnit): string {
  if (unit === 'day') return day;
  if (unit === 'month') return `${day.slice(0, 7)}-01`;
  const date = dayOf(day);
  // Weeks start on Monday; getUTCDay() is 0 on Sunday.
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export function periodLabel(start: string, unit: PeriodUnit): string {
  if (unit === 'day') return formatTrendDay(start);
  if (unit === 'week') return `Week of ${formatTrendDay(start)}`;
  return dayOf(start).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** `points` are oldest first, as the API returns them. The first and last periods can be partial. */
export function toPeriods(points: readonly RevenueTrendPoint[], unit: PeriodUnit): RevenuePeriod[] {
  const periods: RevenuePeriod[] = [];
  for (const point of points) {
    const start = periodStart(point.date, unit);
    let period = periods.at(-1);
    if (period?.start !== start) {
      period = {
        start,
        label: periodLabel(start, unit),
        newMrr: 0,
        churnedMrr: 0,
        net: 0,
        payingUsers: 0,
        payingOrgs: 0,
      };
      periods.push(period);
    }
    period.newMrr += point.newMrr;
    period.churnedMrr += point.churnedMrr;
    period.net = period.newMrr - period.churnedMrr;
    period.payingUsers = point.payingUsers;
    period.payingOrgs = point.payingOrgs;
  }
  return periods;
}

export const OTHER_PLANS_KEY = 'other';
// More stacked bands than this cannot be told apart in one hue.
export const PLAN_SERIES_LIMIT = 4;

export type PlanSeries = { key: string; label: string };

/** The largest plans by name, the rest folded into "Other plans". */
export function planSeries(plans: readonly RevenueTrendPlan[]): PlanSeries[] {
  const named = plans.length > PLAN_SERIES_LIMIT + 1 ? plans.slice(0, PLAN_SERIES_LIMIT) : plans;
  const series = named.map(({ key, plan }) => ({ key, label: plan.name ?? 'Unknown plan' }));
  return named.length < plans.length ? [...series, { key: OTHER_PLANS_KEY, label: 'Other plans' }] : series;
}

export type PlanPoint = { date: string; total: number; values: Record<string, number> };

export function toPlanPoints(points: readonly RevenueTrendPoint[], series: readonly PlanSeries[]): PlanPoint[] {
  const named = new Set(series.map(entry => entry.key).filter(key => key !== OTHER_PLANS_KEY));
  return points.map(point => {
    const values: Record<string, number> = Object.fromEntries(series.map(entry => [entry.key, 0]));
    let total = 0;
    for (const [key, amount] of Object.entries(point.mrrByPlan)) {
      values[named.has(key) ? key : OTHER_PLANS_KEY] += amount;
      total += amount;
    }
    return { date: point.date, total, values };
  });
}

const money = (amount: number) => formatMoney(amount, MRR_CURRENCY);

export function movementTakeaway(periods: readonly RevenuePeriod[]): string {
  const added = periods.reduce((sum, period) => sum + period.newMrr, 0);
  const lost = periods.reduce((sum, period) => sum + period.churnedMrr, 0);
  if (added === 0 && lost === 0) return 'No new or churned MRR in this range.';
  const net = added - lost;
  const headline = net === 0 ? 'New and churned MRR cancel out' : `Net ${signedMoney(net)} MRR`;
  return `${headline} in this range: ${money(added)} new, ${money(lost)} churned.`;
}

export function planTakeaway(points: readonly PlanPoint[], series: readonly PlanSeries[]): string {
  const last = points.at(-1);
  if (!last) return '';
  const day = formatTrendDay(last.date);
  if (last.total <= 0) return `No MRR on ${day}.`;
  const top = series.reduce<PlanSeries | null>(
    (best, entry) =>
      entry.key !== OTHER_PLANS_KEY && (!best || last.values[entry.key] > last.values[best.key]) ? entry : best,
    null
  );
  if (!top) return `${money(last.total)} MRR on ${day}.`;
  return `${top.label} is ${formatShare(last.values[top.key] / last.total)} of MRR on ${day}.`;
}

const counted = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function ownerTakeaway(points: readonly RevenueTrendPoint[]): string {
  const last = points.at(-1);
  if (!last) return '';
  return (
    `${last.payingCount.toLocaleString()} paying on ${formatTrendDay(last.date)}: ` +
    `${counted(last.payingUsers, 'individual', 'individuals')}, ${counted(last.payingOrgs, 'organization', 'organizations')}.`
  );
}

export function atRiskTakeaway(points: readonly RevenueTrendPoint[]): string {
  const last = points.at(-1);
  if (!last) return '';
  const day = formatTrendDay(last.date);
  if (last.pastDueMrr === 0 && last.cancelingMrr === 0) return `No MRR past due or canceling on ${day}.`;
  // The snapshot stores the two separately, so a row that is both is in both.
  return `${money(last.pastDueMrr)} past due and ${money(last.cancelingMrr)} canceling on ${day}. A row can be both.`;
}
