import {
  FUNDING_SOURCE_BY_LOT_SOURCE,
  assignConsumptionFIFO,
  computeConsumption,
  type BillingEventData,
  type FundingLotLike,
} from '@bike4mind/common';
import type { AdminSubscriptionRow } from '@bike4mind/server-utils/app/utils/adminSubscriptionsFilter';
import { isCompSubscription, isTerminalSubscriptionStatus } from '@client/app/utils/adminSubscriptionDetail';
import type {
  BillingActivityItem,
  BillingCurrencyTotals,
  BillingFundingCredits,
  BillingLink,
  BillingOwnerType,
  BillingPaymentRecord,
  BillingSubscription,
  SubscriptionStanding,
} from '@client/app/utils/adminBillingOverview';

/**
 * Pure aggregation behind GET /api/admin/billing-overview (loadBillingOverview.ts does the reads).
 * Kept free of database access so the dedupe, refund and attribution rules are unit-tested on fixtures.
 */

export const PAYMENT_RECORDS_LIMIT = 50;
export const ACTIVITY_ITEMS_LIMIT = 100;

export type PurchaseRow = {
  id: string;
  createdAt: Date;
  credits: number;
  /** Minor units, as charged. */
  amount: number;
  status: string;
  stripePaymentIntentId: string | null;
  reversedAt: Date | null;
  reversalReason: string | null;
};

export type IssuanceRow = {
  id: string;
  createdAt: Date;
  type: string;
  credits: number;
  stripePaymentIntentId: string | null;
  reason: string | null;
  /** A purchase later fully refunded or lost to a dispute. */
  reversed: boolean;
};

export type BillingEventRow = {
  id: string;
  stripeEventId: string;
  type: string;
  occurredAt: Date;
  amount: number | null;
  currency: string | null;
  subscriptionId: string | null;
  data: BillingEventData;
};

export type DailyConsumptionRow = {
  /** UTC `YYYY-MM-DD`. */
  day: string;
  /** The day's latest request, so a row never sorts after something that happened later that day. */
  lastAt: Date;
  credits: number;
  events: number;
  /** Who paid, as `ownerType:ownerId`; keys the row, since labels can repeat. */
  billedToKey: string;
  billedToLabel: string | null;
};

export type PaymentContext = {
  ownerType: BillingOwnerType;
  ownerId: string;
  /** Stripe `sub_...` id to the local Subscription row id, for linking an invoice to its detail page. */
  localSubscriptionIds: ReadonlyMap<string, string>;
};

/** One invoice's duplicates: one carrying an amount wins, then the earliest, so the payment keeps its own time. */
const preferInvoiceEvent = (candidate: BillingEventRow, current: BillingEventRow): boolean => {
  if ((candidate.amount === null) !== (current.amount === null)) return candidate.amount !== null;
  return candidate.occurredAt < current.occurredAt;
};

const SUBSCRIPTION_PAYMENT_TYPES = new Set(['invoice.payment_succeeded', 'invoice.paid']);
const DISPUTE_TYPES = new Set(['charge.dispute.created', 'charge.dispute.closed', 'charge.dispute.updated']);

const INVOICE_LABELS: Readonly<Record<string, string>> = {
  subscription_create: 'First payment',
  subscription_cycle: 'Renewal',
  subscription_update: 'Plan change',
};

const iso = (date: Date) => date.toISOString();

const creditsFormat = new Intl.NumberFormat('en-US');
const formatCredits = (credits: number) => `${creditsFormat.format(Math.round(credits))} credits`;

const newestFirst = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at);

/** Currencies recorded on any event for a payment intent; purchase ledger rows carry none of their own. */
const currencyByPaymentIntent = (events: readonly BillingEventRow[]): Map<string, string> => {
  const currencies = new Map<string, string>();
  for (const event of events) {
    const intent = event.data.paymentIntentId;
    if (intent && event.currency && !currencies.has(intent)) currencies.set(intent, event.currency.toLowerCase());
  }
  return currencies;
};

const purchaseLink = (context: PaymentContext): BillingLink | null =>
  context.ownerType === 'user' ? { kind: 'userCredits', userId: context.ownerId } : null;

const subscriptionLink = (
  stripeSubscriptionId: string | null,
  context: PaymentContext,
  tab: 'overview' | 'invoices'
): BillingLink | null => {
  const localId = stripeSubscriptionId ? context.localSubscriptionIds.get(stripeSubscriptionId) : undefined;
  return localId ? { kind: 'subscription', subscriptionId: localId, tab } : null;
};

const purchaseStatus = (row: PurchaseRow): string =>
  row.reversedAt ? (row.reversalReason ?? 'reversed') : 'completed';

/**
 * Credit purchases from the ledger (completed only, one per payment intent) and subscription payments,
 * refunds and disputes from stored Stripe events, each resolved to one record per Stripe object:
 * - an invoice paid twice over (`invoice.paid` and `invoice.payment_succeeded`, or a redelivery) counts once;
 * - `charge.refunded` carries the charge's cumulative refunded amount, so a charge refunded in parts
 *   counts once, at its largest (latest) cumulative amount, never the sum of the partial events;
 * - a dispute counts once however many updates it received, with its latest status.
 */
export function summarizePayments(
  purchases: readonly PurchaseRow[],
  events: readonly BillingEventRow[],
  context: PaymentContext
): BillingPaymentRecord[] {
  const currencies = currencyByPaymentIntent(events);
  const records: BillingPaymentRecord[] = [];

  const purchasesByIntent = new Map<string, PurchaseRow>();
  for (const row of purchases) {
    if (row.status !== 'completed') continue;
    const key = row.stripePaymentIntentId ?? `ledger:${row.id}`;
    if (purchasesByIntent.has(key)) continue;
    purchasesByIntent.set(key, row);
    records.push({
      id: `purchase:${row.id}`,
      kind: 'credit_purchase',
      at: iso(row.createdAt),
      amount: row.amount,
      currency: row.stripePaymentIntentId ? (currencies.get(row.stripePaymentIntentId) ?? null) : null,
      label: `${formatCredits(row.credits)} purchased`,
      status: purchaseStatus(row),
      credits: row.credits,
      paymentIntentId: row.stripePaymentIntentId,
      link: purchaseLink(context),
    });
  }

  const invoices = new Map<string, BillingEventRow>();
  const refunds = new Map<string, BillingEventRow>();
  const disputes = new Map<string, { first: BillingEventRow; latest: BillingEventRow }>();
  for (const event of events) {
    if (SUBSCRIPTION_PAYMENT_TYPES.has(event.type)) {
      const key = event.data.invoiceId ?? event.data.objectId ?? event.stripeEventId;
      const seen = invoices.get(key);
      if (!seen || preferInvoiceEvent(event, seen)) invoices.set(key, event);
    } else if (event.type === 'charge.refunded') {
      const key = event.data.chargeId ?? event.data.objectId ?? event.stripeEventId;
      const seen = refunds.get(key);
      if (!seen || (event.amount ?? 0) > (seen.amount ?? 0)) refunds.set(key, event);
    } else if (DISPUTE_TYPES.has(event.type)) {
      const key = event.data.disputeId ?? event.data.objectId ?? event.stripeEventId;
      const seen = disputes.get(key);
      if (!seen) disputes.set(key, { first: event, latest: event });
      else {
        if (event.occurredAt < seen.first.occurredAt) seen.first = event;
        if (event.occurredAt >= seen.latest.occurredAt) seen.latest = event;
      }
    }
  }

  const invoiceByIntent = new Map<string, BillingEventRow>();
  for (const [key, event] of invoices) {
    if (event.data.paymentIntentId) invoiceByIntent.set(event.data.paymentIntentId, event);
    records.push({
      id: `invoice:${key}`,
      kind: 'subscription_payment',
      at: iso(event.occurredAt),
      amount: event.amount,
      currency: event.currency?.toLowerCase() ?? null,
      label: (event.data.billingReason && INVOICE_LABELS[event.data.billingReason]) || 'Subscription payment',
      status: event.data.status ?? 'paid',
      credits: null,
      paymentIntentId: event.data.paymentIntentId ?? null,
      link: subscriptionLink(event.subscriptionId, context, 'invoices'),
    });
  }

  for (const [key, event] of refunds) {
    const intent = event.data.paymentIntentId ?? null;
    const purchase = intent ? purchasesByIntent.get(intent) : undefined;
    const invoice = intent ? invoiceByIntent.get(intent) : undefined;
    const original = purchase?.amount ?? invoice?.amount ?? null;
    const refunded = event.amount;
    const scope =
      original === null || refunded === null ? 'Refund' : refunded >= original ? 'Full refund' : 'Partial refund';
    const of = purchase ? ' of a credit purchase' : invoice ? ' of a subscription payment' : '';
    records.push({
      id: `refund:${key}`,
      kind: 'refund',
      at: iso(event.occurredAt),
      amount: refunded,
      currency: event.currency?.toLowerCase() ?? null,
      label: `${scope}${of}`,
      status: 'refunded',
      credits: null,
      paymentIntentId: intent,
      link: purchase
        ? purchaseLink(context)
        : invoice
          ? subscriptionLink(invoice.subscriptionId, context, 'invoices')
          : null,
    });
  }

  for (const [key, { first, latest }] of disputes) {
    records.push({
      id: `dispute:${key}`,
      kind: 'dispute',
      at: iso(first.occurredAt),
      amount: first.amount ?? latest.amount,
      currency: (first.currency ?? latest.currency)?.toLowerCase() ?? null,
      label: latest.data.reason ? `Dispute (${latest.data.reason.replace(/_/g, ' ')})` : 'Dispute',
      status: latest.data.status ?? null,
      credits: null,
      paymentIntentId: first.data.paymentIntentId ?? latest.data.paymentIntentId ?? null,
      link: { kind: 'disputes' },
    });
  }

  return records.sort(newestFirst);
}

const emptyTotals = (currency: string | null): BillingCurrencyTotals => ({
  currency,
  creditPurchases: { count: 0, amount: 0 },
  subscriptionPayments: { count: 0, amount: 0 },
  refunds: { count: 0, amount: 0 },
  disputes: { count: 0, amount: 0 },
});

const TOTAL_KEY: Readonly<Record<BillingPaymentRecord['kind'], keyof Omit<BillingCurrencyTotals, 'currency'>>> = {
  credit_purchase: 'creditPurchases',
  subscription_payment: 'subscriptionPayments',
  refund: 'refunds',
  dispute: 'disputes',
};

/**
 * One row per currency, so amounts in different currencies are never added. A record with no
 * currency gets its own row; one with no amount is counted but adds nothing.
 */
export function totalsByCurrency(records: readonly BillingPaymentRecord[]): BillingCurrencyTotals[] {
  const byCurrency = new Map<string | null, BillingCurrencyTotals>();
  for (const record of records) {
    const totals = byCurrency.get(record.currency) ?? emptyTotals(record.currency);
    byCurrency.set(record.currency, totals);
    const bucket = totals[TOTAL_KEY[record.kind]];
    bucket.count += 1;
    bucket.amount += record.amount ?? 0;
  }
  // Known currencies alphabetically, the unknown-currency row last.
  return [...byCurrency.values()].sort((a, b) =>
    a.currency === b.currency
      ? 0
      : a.currency === null
        ? 1
        : b.currency === null
          ? -1
          : a.currency.localeCompare(b.currency)
  );
}

/**
 * What the balance is made of, by the lots still holding credits (the same soonest-expiry-first
 * assignment the balance endpoint and the usage stamp use). Balance no live lot covers is `unknown`;
 * a negative balance is all debt, so every source reads zero.
 */
export function fundingOfBalance(lots: readonly FundingLotLike[], currentCredits: number): BillingFundingCredits {
  const funding: BillingFundingCredits = { purchased: 0, subscription: 0, granted: 0, unknown: 0 };
  if (currentCredits <= 0) return funding;
  const liveLots = lots.filter(lot => !lot.settledAt);
  const assigned = assignConsumptionFIFO(liveLots, computeConsumption(liveLots, currentCredits));
  let covered = 0;
  for (const { lot, remaining } of assigned) {
    if (remaining <= 0) continue;
    funding[lot.fundingSource ?? FUNDING_SOURCE_BY_LOT_SOURCE[lot.source]] += remaining;
    covered += remaining;
  }
  funding.unknown += Math.max(0, currentCredits - covered);
  return funding;
}

const STATUS_PRIORITY = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'];

const toBillingSubscription = (row: AdminSubscriptionRow): BillingSubscription => ({
  id: row.id,
  planName: row.plan.name,
  status: row.status,
  source: row.source,
  comped: isCompSubscription(row),
  quantity: row.quantity,
  periodEndsAt: row.periodEndsAt,
  cancelAt: row.cancelAt,
  canceledAt: row.canceledAt,
  createdAt: row.createdAt,
});

/**
 * The owner's own subscription standing. `rows` are this owner's subscriptions only, newest first: a
 * user's organization memberships are separate owners and never decide their standing.
 */
export function subscriptionStanding(rows: readonly AdminSubscriptionRow[]): {
  standing: SubscriptionStanding;
  current: BillingSubscription | null;
  previous: BillingSubscription[];
} {
  const live = rows.filter(row => !isTerminalSubscriptionStatus(row.status));
  const rank = (row: AdminSubscriptionRow) => {
    const index = STATUS_PRIORITY.indexOf(row.status);
    return index === -1 ? STATUS_PRIORITY.length : index;
  };
  const current = [...live].sort((a, b) => rank(a) - rank(b))[0] ?? null;
  const previous = rows
    .filter(row => row !== current)
    .slice(0, 5)
    .map(toBillingSubscription);
  if (!current) return { standing: rows.length > 0 ? 'ended' : 'none', current: null, previous };

  let standing: SubscriptionStanding;
  if (isCompSubscription(current)) standing = 'comped';
  else if (current.status === 'trialing') standing = 'trial';
  else if (current.status === 'active') standing = 'paid';
  else if (current.status === 'paused') standing = 'ended';
  else standing = 'past_due';
  return { standing, current: toBillingSubscription(current), previous };
}

const ISSUANCE_LABELS: Readonly<Record<string, string>> = {
  purchase: 'Credits from a purchase',
  subscription: 'Subscription credits',
  generic_add: 'Credits granted',
  received_credit: 'Credits received',
};

const PAYMENT_ACTIVITY_KIND: Readonly<Record<BillingPaymentRecord['kind'], BillingActivityItem['kind']>> = {
  credit_purchase: 'payment',
  subscription_payment: 'payment',
  refund: 'refund',
  dispute: 'dispute',
};

/**
 * Payments, credit issuances and daily consumption on one newest-first list. An issuance is linked to a
 * payment only when both rows name the same Stripe payment intent; consumption is never linked to a
 * payment or an issuance, since the ledger does not record which credits a charge spent.
 */
export function buildActivity(
  payments: readonly BillingPaymentRecord[],
  issuances: readonly IssuanceRow[],
  consumption: readonly DailyConsumptionRow[]
): { items: BillingActivityItem[]; truncated: boolean } {
  const paymentByIntent = new Map<string, string>();
  const items: BillingActivityItem[] = payments.map(payment => {
    const id = `activity:${payment.id}`;
    if (payment.paymentIntentId && PAYMENT_ACTIVITY_KIND[payment.kind] === 'payment') {
      paymentByIntent.set(payment.paymentIntentId, id);
    }
    return {
      id,
      at: payment.at,
      kind: PAYMENT_ACTIVITY_KIND[payment.kind],
      summary: payment.label,
      credits: null,
      amount: payment.amount,
      currency: payment.currency,
      verifiedLinkTo: null,
      link: payment.link,
    };
  });

  for (const row of issuances) {
    if (row.credits <= 0) continue;
    items.push({
      id: `activity:credit:${row.id}`,
      at: iso(row.createdAt),
      kind: 'credit_issued',
      summary: `${ISSUANCE_LABELS[row.type] ?? 'Credits added'}${row.reversed ? ' (purchase later reversed)' : ''}`,
      credits: row.credits,
      amount: null,
      currency: null,
      verifiedLinkTo: row.stripePaymentIntentId ? (paymentByIntent.get(row.stripePaymentIntentId) ?? null) : null,
      link: null,
    });
  }

  for (const row of consumption) {
    if (row.credits <= 0 && row.events === 0) continue;
    const billed = row.billedToLabel ? `, billed to ${row.billedToLabel}` : '';
    items.push({
      id: `activity:usage:${row.day}:${row.billedToKey}`,
      at: iso(row.lastAt),
      kind: 'consumption',
      summary: `${creditsFormat.format(row.events)} ${row.events === 1 ? 'request' : 'requests'}${billed}`,
      credits: -row.credits,
      amount: null,
      currency: null,
      verifiedLinkTo: null,
      link: null,
    });
  }

  items.sort(newestFirst);
  return { items: items.slice(0, ACTIVITY_ITEMS_LIMIT), truncated: items.length > ACTIVITY_ITEMS_LIMIT };
}
