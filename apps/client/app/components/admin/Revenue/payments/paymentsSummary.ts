import type {
  AdminPaymentsSummaryResponse,
  PaymentsCurrencyTotals,
  PaymentsPeriodSummary,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { formatTrendDay } from '../revenueFormat';
import type { PaymentsChartPoint } from './PaymentsChart';

/** Gross is unknown when subscription payments are (`subscriptionGross` null), never a partial sum. */
export const grossOf = (totals: PaymentsCurrencyTotals): number | null =>
  totals.subscriptionGross === null ? null : totals.subscriptionGross + totals.creditGross;

export const refundsAndDisputesOf = (totals: PaymentsCurrencyTotals): number => totals.refunds + totals.disputeLosses;

/** The period's totals in `currency`; a period with no money in it reads as zero, keeping its coverage. */
export function totalsIn(period: PaymentsPeriodSummary, currency: string): PaymentsCurrencyTotals {
  const found = period.totals.find(entry => entry.currency === currency);
  if (found) return found;
  const subscriptionsKnown = period.totals.every(entry => entry.subscriptionGross !== null);
  const netKnown = period.totals.every(entry => entry.net !== null);
  return {
    currency,
    subscriptionGross: subscriptionsKnown ? 0 : null,
    subscriptionCount: subscriptionsKnown ? 0 : null,
    creditGross: 0,
    creditCount: 0,
    refunds: 0,
    disputeLosses: 0,
    net: netKnown ? 0 : null,
  };
}

/** The currency the strip shows: the picked one, else the filter's, else USD, else the first. */
export function summaryCurrency(currencies: readonly string[], picked: string | undefined, filtered?: string) {
  for (const candidate of [picked, filtered, 'usd']) {
    if (candidate && currencies.includes(candidate)) return candidate;
  }
  return currencies[0] ?? filtered ?? 'usd';
}

const formatMonth = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function chartPoints(summary: AdminPaymentsSummaryResponse, currency: string): PaymentsChartPoint[] {
  const label = summary.bucket === 'month' ? formatMonth : formatTrendDay;
  return summary.series
    .filter(point => point.currency === currency)
    .map(point => ({
      date: point.date,
      label: label(point.date),
      subscription: point.subscription,
      creditPurchase: point.creditPurchase,
    }));
}

export type BreakdownRow = {
  id: string;
  label: string;
  current: number | null;
  previous: number | null;
  count?: number | null;
  /** Sums and averages read as a summary line. */
  total?: boolean;
};

/** A deduction shown as negative money; zero stays 0 rather than -0 ("-$0.00"). */
export const negate = (amount: number): number => (amount === 0 ? 0 : -amount);

const average = (amount: number, count: number): number | null => (count > 0 ? Math.round(amount / count) : null);

export function breakdownRows(current: PaymentsCurrencyTotals, previous: PaymentsCurrencyTotals): BreakdownRow[] {
  return [
    {
      id: 'subscriptions',
      label: 'Subscription payments',
      current: current.subscriptionGross,
      previous: previous.subscriptionGross,
      count: current.subscriptionCount,
    },
    {
      id: 'credits',
      label: 'Credit purchases',
      current: current.creditGross,
      previous: previous.creditGross,
      count: current.creditCount,
    },
    { id: 'gross', label: 'Gross', current: grossOf(current), previous: grossOf(previous), total: true },
    { id: 'refunds', label: 'Refunds', current: negate(current.refunds), previous: negate(previous.refunds) },
    {
      id: 'disputes',
      label: 'Dispute losses',
      current: negate(current.disputeLosses),
      previous: negate(previous.disputeLosses),
    },
    { id: 'net', label: 'Net', current: current.net, previous: previous.net, total: true },
    {
      id: 'average-credit',
      label: 'Average credit purchase',
      current: average(current.creditGross, current.creditCount),
      previous: average(previous.creditGross, previous.creditCount),
    },
  ];
}
