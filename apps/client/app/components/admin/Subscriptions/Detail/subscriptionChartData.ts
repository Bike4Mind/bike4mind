import type {
  AdminSubscriptionCreditCycle,
  AdminSubscriptionSeatChange,
  AdminSubscriptionSeats,
} from '@client/app/utils/adminSubscriptionDetail';
import { invoiceAmount, type AdminStripeInvoice } from '@client/app/utils/adminSubscriptionStripe';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { formatMoney } from '../../shared/formatMoney';
import { formatCredits } from '../../Users/Profile/actions/creditAdjustment';
import { formatDate } from './subscriptionDetailModel';

/** Chart data for the subscription detail page (docs/admin-subscriptions-spec.md 5.7). Pure. */

/** Bars stay readable: two years of monthly invoices. */
export const MAX_PAYMENT_BARS = 24;

export type PaymentOutcome = 'paid' | 'refunded' | 'failed' | 'open' | 'void';

export const PAYMENT_OUTCOMES: Readonly<Record<PaymentOutcome, { label: string; tone: AdminStatusTone }>> = {
  paid: { label: 'Paid', tone: 'good' },
  refunded: { label: 'Refunded', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  open: { label: 'Open', tone: 'info' },
  void: { label: 'Void', tone: 'neutral' },
};

export type PaymentBar = {
  id: string;
  number: string | null;
  createdAt: string;
  /** Minor units: what was charged once paid, what Stripe asked for otherwise. */
  amount: number;
  refunded: number;
  currency: string;
  outcome: PaymentOutcome;
};

/** An open invoice with a failed attempt is a failed payment; one not yet attempted is just open. */
export function paymentOutcome(
  invoice: Pick<AdminStripeInvoice, 'status' | 'attempts' | 'amountRefunded'>
): PaymentOutcome {
  if (invoice.status === 'paid') return invoice.amountRefunded > 0 ? 'refunded' : 'paid';
  if (invoice.status === 'uncollectible') return 'failed';
  if (invoice.status === 'open') return invoice.attempts > 0 ? 'failed' : 'open';
  if (invoice.status === 'void') return 'void';
  return 'open';
}

export type PaymentHistory = {
  /** Oldest first. */
  bars: PaymentBar[];
  /** The currency charted: the latest invoice's. */
  currency: string | null;
  /** Invoices in another currency, which do not share an axis with the rest: table tab only. */
  otherCurrencyCount: number;
  /** Older invoices past MAX_PAYMENT_BARS. */
  olderCount: number;
};

/** `invoices` newest first, as the Stripe read returns them. Drafts are not charges yet, so they are left out. */
export function toPaymentHistory(invoices: readonly AdminStripeInvoice[]): PaymentHistory {
  const billed = invoices.filter(invoice => invoice.status !== 'draft');
  const currency = billed[0]?.currency ?? null;
  const same = billed.filter(invoice => invoice.currency === currency);
  const shown = same.slice(0, MAX_PAYMENT_BARS);
  return {
    bars: shown.reverse().map(invoice => ({
      id: invoice.id,
      number: invoice.number,
      createdAt: invoice.createdAt,
      amount: invoiceAmount(invoice),
      refunded: invoice.amountRefunded,
      currency: invoice.currency,
      outcome: paymentOutcome(invoice),
    })),
    currency,
    otherCurrencyCount: billed.length - same.length,
    olderCount: same.length - shown.length,
  };
}

export function paymentTakeaway({ bars }: PaymentHistory): string {
  const first = bars[0];
  const last = bars.at(-1);
  if (!first || !last) return '';
  const counts = (Object.keys(PAYMENT_OUTCOMES) as PaymentOutcome[])
    .map(outcome => ({ outcome, count: bars.filter(bar => bar.outcome === outcome).length }))
    .filter(({ count }) => count > 0)
    .map(({ outcome, count }) => `${count} ${PAYMENT_OUTCOMES[outcome].label.toLowerCase()}`);
  const noun = bars.length === 1 ? 'invoice' : 'invoices';
  const latest = `Latest: ${formatMoney(last.amount, last.currency)} ${PAYMENT_OUTCOMES[last.outcome].label.toLowerCase()} on ${formatDate(last.createdAt)}.`;
  return `${bars.length} ${noun} since ${formatDate(first.createdAt)}: ${counts.join(', ')}. ${latest}`;
}

export type CreditCyclePoint = AdminSubscriptionCreditCycle & { label: string };

export const toCreditCyclePoints = (cycles: readonly AdminSubscriptionCreditCycle[]): CreditCyclePoint[] =>
  cycles.map(cycle => ({ ...cycle, label: formatDate(cycle.start) ?? cycle.start }));

const share = (used: number, granted: number) => (granted > 0 ? ` (${Math.round((used / granted) * 100)}%)` : '');

export function creditsTakeaway(points: readonly CreditCyclePoint[]): string {
  const complete = points.filter(point => !point.current);
  const lastComplete = complete.at(-1);
  const current = points.find(point => point.current);
  const parts: string[] = [];
  if (lastComplete) {
    parts.push(
      `The last full cycle used ${formatCredits(lastComplete.used)} of ${formatCredits(lastComplete.granted)} credits granted${share(lastComplete.used, lastComplete.granted)}.`
    );
  }
  if (current) {
    parts.push(
      `${lastComplete ? 'This' : 'The first'} cycle has used ${formatCredits(current.used)} of ${formatCredits(current.granted)} so far.`
    );
  }
  return parts.join(' ');
}

export type SeatPoint = {
  /** Epoch ms, so the steps are spaced by time. */
  at: number;
  paid: number;
  /** Only today's count is known: member history is not recorded. */
  used: number | null;
};

/** The recorded paid-seat changes, then today with our records' paid count and today's members. */
export function toSeatPoints(
  changes: readonly AdminSubscriptionSeatChange[],
  seats: Pick<AdminSubscriptionSeats, 'paid' | 'members'>,
  now: number
): SeatPoint[] {
  return [
    ...changes.map(change => ({ at: new Date(change.at).getTime(), paid: change.quantity, used: null })),
    { at: now, paid: seats.paid, used: seats.members },
  ];
}

export function seatsTakeaway(
  changes: readonly AdminSubscriptionSeatChange[],
  seats: Pick<AdminSubscriptionSeats, 'paid' | 'members'>
): string {
  const today = `${seats.members.toLocaleString('en-US')} of ${seats.paid.toLocaleString('en-US')} paid seats used today.`;
  const first = changes[0];
  if (!first) return today;
  const since = formatDate(first.at);
  if (first.quantity === seats.paid) return `${today} Paid seats unchanged at ${seats.paid} since ${since}.`;
  return `${today} Paid seats went from ${first.quantity} to ${seats.paid} since ${since}.`;
}
