import { BillingEventModel, CreditTransaction, Organization, User, mongoose } from '@bike4mind/database';
import {
  CREDIT_PURCHASE_CURRENCY,
  previousPaymentsWindow,
  resolvePaymentsWindow,
  daysBetween,
  type AdminPaymentOwner,
  type AdminPaymentRow,
  type AdminPaymentsFilter,
  type AdminPaymentsListResponse,
  type AdminPaymentsQuery,
  type AdminPaymentsSummaryResponse,
  type PaymentKind,
  type PaymentsCoverage,
  type PaymentsCurrencyTotals,
  type PaymentsPeriodSummary,
  type PaymentsSeriesPoint,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import {
  CHARGE_REFUNDED,
  DISPUTE_CLOSED,
  INVOICE_FAILED,
  INVOICE_PAID,
  PAYMENTS_READ_MAX_TIME_MS,
  PAYMENTS_SORT,
  aggregatePayments,
  followUpMatch,
  includesCreditPurchases,
  includesSubscriptionPayments,
  paymentStatusStages,
  purchaseMatch,
  resolvePaymentsSearch,
  type PaymentWithStatus,
  type PaymentsScope,
  type Stage,
  type PaymentsWindow,
} from './paymentsQuery';

const INVOICE_OUTCOMES = [INVOICE_PAID, INVOICE_FAILED] as const;
/** Statuses a lookup-free read can match on the source's own outcome. */
const OUTCOME_ONLY_STATUSES = new Set(['pending', 'failed']);

const toScope = async (filter: AdminPaymentsFilter): Promise<PaymentsScope> => ({
  kind: filter.kind,
  ownerType: filter.ownerType,
  currency: filter.currency,
  minAmount: filter.minAmount,
  maxAmount: filter.maxAmount,
  search: await resolvePaymentsSearch(filter.search),
});

const toObjectIds = (ids: string[]) =>
  ids.filter(id => mongoose.isValidObjectId(id)).map(id => new mongoose.Types.ObjectId(id));

/** Names for a page of rows; an owner that no longer exists stays null. */
async function ownersOf(rows: PaymentWithStatus[]): Promise<Map<string, AdminPaymentOwner>> {
  const userIds = [...new Set(rows.filter(row => row.ownerType === 'user').map(row => row.ownerId))];
  const organizationIds = [...new Set(rows.filter(row => row.ownerType === 'organization').map(row => row.ownerId))];
  const [users, organizations] = await Promise.all([
    userIds.length > 0
      ? User.find({ _id: { $in: toObjectIds(userIds) } })
          .select('name username email')
          .lean()
      : [],
    organizationIds.length > 0
      ? Organization.find({ _id: { $in: toObjectIds(organizationIds) } })
          .select('name')
          .lean()
      : [],
  ]);
  const owners = new Map<string, AdminPaymentOwner>();
  for (const user of users) {
    const id = String(user._id);
    owners.set(`user:${id}`, { kind: 'user', id, name: user.name ?? user.username ?? null, email: user.email ?? null });
  }
  for (const organization of organizations) {
    const id = String(organization._id);
    owners.set(`organization:${id}`, { kind: 'organization', id, name: organization.name ?? null });
  }
  return owners;
}

export async function toPaymentRows(rows: PaymentWithStatus[]): Promise<AdminPaymentRow[]> {
  const owners = await ownersOf(rows);
  return rows.map(row => ({
    id: String(row._id),
    kind: row.kind,
    status: row.status,
    occurredAt: new Date(row.occurredAt).toISOString(),
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    owner: owners.get(`${row.ownerType}:${row.ownerId}`) ?? null,
    amount: row.amount,
    currency: row.currency,
    refundedAmount: row.refundedAmount,
    credits: row.credits,
    paymentIntentId: row.paymentIntentId,
    invoiceId: row.invoiceId,
    subscriptionId: row.subscriptionId,
  }));
}

/**
 * The status filter as stages. `pending` and `failed` are the source's own outcome, so they match before
 * the follow-up lookup; every other status needs it, so the lookup runs on the whole window first.
 */
function statusStages(status: AdminPaymentsFilter['status']): { before: Stage[]; lookupFirst: boolean } {
  if (!status) return { before: [], lookupFirst: false };
  if (OUTCOME_ONLY_STATUSES.has(status)) return { before: [{ $match: { outcome: status } }], lookupFirst: false };
  return {
    before: [{ $match: { outcome: 'completed' } }, ...paymentStatusStages, { $match: { status } }],
    lookupFirst: true,
  };
}

/** One page of the filtered payments, newest first. */
export async function listAdminPayments(
  query: AdminPaymentsQuery,
  now = new Date()
): Promise<AdminPaymentsListResponse> {
  const window = resolvePaymentsWindow(query, now);
  const scope = await toScope(query);
  const { before, lookupFirst } = statusStages(query.status);
  const skip = (query.page - 1) * query.limit;
  const [result] = await aggregatePayments<{ rows: PaymentWithStatus[]; total: { count: number }[] }>(
    scope,
    window,
    { invoiceTypes: INVOICE_OUTCOMES },
    [
      ...before,
      {
        $facet: {
          rows: [PAYMENTS_SORT, { $skip: skip }, { $limit: query.limit }, ...(lookupFirst ? [] : paymentStatusStages)],
          total: [{ $count: 'count' }],
        },
      },
    ]
  );
  const total = result?.total[0]?.count ?? 0;
  return {
    payments: await toPaymentRows(result?.rows ?? []),
    total,
    page: query.page,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
    searchTruncated: scope.search.truncated,
  };
}

/** Up to `limit` filtered payments, newest first, for the CSV export. */
export async function exportAdminPayments(
  filter: AdminPaymentsFilter,
  limit: number,
  now = new Date()
): Promise<{ rows: AdminPaymentRow[]; searchTruncated: boolean }> {
  const window = resolvePaymentsWindow(filter, now);
  const scope = await toScope(filter);
  const { before, lookupFirst } = statusStages(filter.status);
  const rows = await aggregatePayments<PaymentWithStatus>(scope, window, { invoiceTypes: INVOICE_OUTCOMES }, [
    ...before,
    PAYMENTS_SORT,
    { $limit: limit },
    ...(lookupFirst ? [] : paymentStatusStages),
  ]);
  return { rows: await toPaymentRows(rows), searchTruncated: scope.search.truncated };
}

/**
 * When the BillingEvent store started recording, from its oldest row (the `_id` index, so no scan).
 * Before that there are no subscription payments, refund amounts or dispute amounts to report.
 */
export async function billingEventsRecordedFrom(): Promise<Date | null> {
  const first = await BillingEventModel.findOne({}).sort({ _id: 1 }).select('createdAt occurredAt').lean();
  if (!first) return null;
  return first.createdAt ?? first.occurredAt ?? null;
}

export function coverageFor(window: PaymentsWindow, recordedFrom: Date | null): PaymentsCoverage {
  if (!recordedFrom || recordedFrom >= window.end) {
    return { recordedFrom: recordedFrom?.toISOString() ?? null, stripeEvents: 'unavailable' };
  }
  return {
    recordedFrom: recordedFrom.toISOString(),
    stripeEvents: recordedFrom > window.start ? 'partial' : 'complete',
  };
}

type GrossGroup = {
  _id: { currency: string; kind: PaymentKind; ownerType: string; ownerId: string };
  amount: number;
  count: number;
};

type MoneyByCurrency = Map<string, { subscription: number; creditPurchase: number }>;

const addTo = (totals: MoneyByCurrency, currency: string, kind: PaymentKind, amount: number) => {
  const entry = totals.get(currency) ?? { subscription: 0, creditPurchase: 0 };
  if (kind === 'subscription') entry.subscription += amount;
  else entry.creditPurchase += amount;
  totals.set(currency, entry);
};

type RefundEvent = {
  stripeEventId: string;
  occurredAt: Date;
  amount: number | null;
  currency: string | null;
  data?: { chargeId?: string; paymentIntentId?: string; disputeId?: string };
};

type PurchaseRef = { stripePaymentIntentId?: string; amount?: number };

/** Which payment intents are credit purchases; every other charge this stage records is a subscription invoice. */
async function creditPurchaseIntents(paymentIntentIds: string[]): Promise<Set<string>> {
  if (paymentIntentIds.length === 0) return new Set();
  const rows = await CreditTransaction.find({ type: 'purchase', stripePaymentIntentId: { $in: paymentIntentIds } })
    .select('stripePaymentIntentId')
    .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
    .lean<PurchaseRef[]>();
  return new Set(rows.flatMap(row => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : [])));
}

const kindOf = (paymentIntentId: string | undefined, creditIntents: Set<string>): PaymentKind =>
  paymentIntentId && creditIntents.has(paymentIntentId) ? 'credit_purchase' : 'subscription';

/**
 * Money refunded in the window. `charge.refunded` carries the charge's cumulative refunded amount, so each
 * event counts only its increase over the largest amount seen for that charge before it (including before
 * the window); a webhook retry under the same event id is stored once, and a re-sent total adds nothing.
 */
async function refundsInWindow(scope: PaymentsScope, window: PaymentsWindow): Promise<RefundEvent[]> {
  const events = await BillingEventModel.find(followUpMatch(scope, window, CHARGE_REFUNDED))
    .select('stripeEventId occurredAt amount currency data.chargeId data.paymentIntentId')
    .sort({ occurredAt: 1, _id: 1 })
    .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
    .lean<RefundEvent[]>();
  const chargeIds = [...new Set(events.flatMap(event => (event.data?.chargeId ? [event.data.chargeId] : [])))];
  const prior =
    chargeIds.length > 0
      ? await BillingEventModel.aggregate<{ _id: string; amount: number }>([
          { $match: { type: CHARGE_REFUNDED, occurredAt: { $lt: window.start }, 'data.chargeId': { $in: chargeIds } } },
          { $group: { _id: '$data.chargeId', amount: { $max: '$amount' } } },
        ]).option({ maxTimeMS: PAYMENTS_READ_MAX_TIME_MS })
      : [];
  const seen = new Map(prior.map(row => [row._id, row.amount ?? 0]));
  return events.flatMap(event => {
    const total = event.amount ?? 0;
    const chargeId = event.data?.chargeId;
    if (!chargeId) return [event];
    const before = seen.get(chargeId) ?? 0;
    seen.set(chargeId, Math.max(before, total));
    const increase = total - before;
    return increase > 0 ? [{ ...event, amount: increase }] : [];
  });
}

/** Lost disputes closed in the window, one per dispute. */
async function disputeLossesInWindow(scope: PaymentsScope, window: PaymentsWindow): Promise<RefundEvent[]> {
  const events = await BillingEventModel.find({
    ...followUpMatch(scope, window, DISPUTE_CLOSED),
    'data.status': 'lost',
  })
    .select('stripeEventId occurredAt amount currency data.disputeId data.paymentIntentId')
    .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
    .lean<RefundEvent[]>();
  const byDispute = new Map<string, RefundEvent>();
  for (const event of events) byDispute.set(event.data?.disputeId ?? event.stripeEventId, event);
  return [...byDispute.values()];
}

/**
 * Purchases reversed in the window that have no matching Stripe event, which is every reversal from before
 * the event store existed. The ledger flag only records a full refund or a lost dispute, so the purchase
 * amount is the amount; a partial refund from that time is unknown and not counted.
 */
async function legacyReversalsInWindow(
  scope: PaymentsScope,
  window: PaymentsWindow,
  reason: 'refunded' | 'dispute_lost'
): Promise<number> {
  if (!includesCreditPurchases(scope)) return 0;
  const reversed = await CreditTransaction.find({
    ...purchaseMatch(scope, { start: new Date(0), end: window.end }, {}),
    reversalReason: reason,
    reversedAt: { $gte: window.start, $lt: window.end },
  })
    .select('stripePaymentIntentId amount')
    .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
    .lean<PurchaseRef[]>();
  if (reversed.length === 0) return 0;
  const intents = reversed.flatMap(row => (row.stripePaymentIntentId ? [row.stripePaymentIntentId] : []));
  const recorded = new Set(
    (
      await BillingEventModel.find({
        type: reason === 'refunded' ? CHARGE_REFUNDED : DISPUTE_CLOSED,
        'data.paymentIntentId': { $in: intents },
      })
        .select('data.paymentIntentId')
        .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
        .lean<RefundEvent[]>()
    ).flatMap(event => (event.data?.paymentIntentId ? [event.data.paymentIntentId] : []))
  );
  return reversed
    .filter(row => !row.stripePaymentIntentId || !recorded.has(row.stripePaymentIntentId))
    .reduce((sum, row) => sum + (row.amount ?? 0), 0);
}

/** Sums follow-up events per currency, keeping only the kinds the scope asks for. */
function followUpTotals(events: RefundEvent[], creditIntents: Set<string>, scope: PaymentsScope): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of events) {
    const kind = kindOf(event.data?.paymentIntentId, creditIntents);
    if (scope.kind && scope.kind !== kind) continue;
    const currency = event.currency ?? CREDIT_PURCHASE_CURRENCY;
    totals.set(currency, (totals.get(currency) ?? 0) + (event.amount ?? 0));
  }
  return totals;
}

/**
 * One period's totals. The amount and status filters narrow the table only: the summary is about money
 * moved, so it always counts every successful payment, refund and lost dispute in the scope.
 */
export async function paymentsPeriodSummary(
  filter: AdminPaymentsFilter,
  scope: PaymentsScope,
  window: { from: string; to: string; start: Date; end: Date },
  recordedFrom: Date | null
): Promise<PaymentsPeriodSummary> {
  const coverage = coverageFor(window, recordedFrom);
  const totalsScope: PaymentsScope = { ...scope, minAmount: undefined, maxAmount: undefined };

  const [groups, refundEvents, disputeEvents, legacyRefunds, legacyDisputes] = await Promise.all([
    aggregatePayments<GrossGroup>(totalsScope, window, { invoiceTypes: [INVOICE_PAID] }, [
      { $match: { outcome: 'completed' } },
      {
        $group: {
          _id: { currency: '$currency', kind: '$kind', ownerType: '$ownerType', ownerId: '$ownerId' },
          amount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),
    refundsInWindow(totalsScope, window),
    disputeLossesInWindow(totalsScope, window),
    legacyReversalsInWindow(totalsScope, window, 'refunded'),
    legacyReversalsInWindow(totalsScope, window, 'dispute_lost'),
  ]);

  const creditIntents = await creditPurchaseIntents([
    ...new Set(
      [...refundEvents, ...disputeEvents].flatMap(event =>
        event.data?.paymentIntentId ? [event.data.paymentIntentId] : []
      )
    ),
  ]);
  const refunds = followUpTotals(refundEvents, creditIntents, totalsScope);
  const disputes = followUpTotals(disputeEvents, creditIntents, totalsScope);
  if (legacyRefunds > 0)
    refunds.set(CREDIT_PURCHASE_CURRENCY, (refunds.get(CREDIT_PURCHASE_CURRENCY) ?? 0) + legacyRefunds);
  if (legacyDisputes > 0) {
    disputes.set(CREDIT_PURCHASE_CURRENCY, (disputes.get(CREDIT_PURCHASE_CURRENCY) ?? 0) + legacyDisputes);
  }

  const gross: MoneyByCurrency = new Map();
  const counts: MoneyByCurrency = new Map();
  const payerKinds = new Map<string, Set<PaymentKind>>();
  const buyers = new Map<string, { ownerType: string; ownerId: string }>();
  for (const group of groups) {
    const { currency, kind, ownerType, ownerId } = group._id;
    addTo(gross, currency, kind, group.amount);
    addTo(counts, currency, kind, group.count);
    const key = `${ownerType}:${ownerId}`;
    payerKinds.set(key, (payerKinds.get(key) ?? new Set()).add(kind));
    if (kind === 'credit_purchase') buyers.set(key, { ownerType, ownerId });
  }

  // Unknown only when the range needs subscription payments and the store does not cover it; a Type
  // filter that leaves them out makes them a known zero.
  const subscriptionsKnown = coverage.stripeEvents !== 'unavailable' || !includesSubscriptionPayments(totalsScope);
  const currencies = [...new Set([...gross.keys(), ...refunds.keys(), ...disputes.keys()])].sort();
  if (currencies.length === 0) currencies.push(filter.currency ?? CREDIT_PURCHASE_CURRENCY);
  const totals: PaymentsCurrencyTotals[] = currencies.map(currency => {
    const subscriptionGross = subscriptionsKnown ? (gross.get(currency)?.subscription ?? 0) : null;
    const creditGross = gross.get(currency)?.creditPurchase ?? 0;
    const refundTotal = refunds.get(currency) ?? 0;
    const disputeTotal = disputes.get(currency) ?? 0;
    return {
      currency,
      subscriptionGross,
      subscriptionCount: subscriptionsKnown ? (counts.get(currency)?.subscription ?? 0) : null,
      creditGross,
      creditCount: counts.get(currency)?.creditPurchase ?? 0,
      refunds: refundTotal,
      disputeLosses: disputeTotal,
      // Without subscription payments there is no honest net, only a partial one.
      net: subscriptionGross === null ? null : subscriptionGross + creditGross - refundTotal - disputeTotal,
    };
  });

  let subscriptionOnly = 0;
  let creditOnly = 0;
  let both = 0;
  for (const kinds of payerKinds.values()) {
    if (kinds.size === 2) both += 1;
    else if (kinds.has('subscription')) subscriptionOnly += 1;
    else creditOnly += 1;
  }

  const purchases = [...counts.values()].reduce((sum, entry) => sum + entry.creditPurchase, 0);
  const repeat = await repeatBuyers([...buyers.values()], window.start);
  return {
    from: window.from,
    to: window.to,
    totals,
    payers: { total: payerKinds.size, subscriptionOnly, creditOnly, both },
    creditBuyers: { purchases, buyers: buyers.size, firstTime: buyers.size - repeat, repeat },
    coverage,
  };
}

/** Buyers with a completed purchase before `before`. The ledger keeps every purchase, so this history is complete. */
async function repeatBuyers(buyers: { ownerType: string; ownerId: string }[], before: Date): Promise<number> {
  if (buyers.length === 0) return 0;
  const byType = (type: string) => buyers.filter(buyer => buyer.ownerType === type).map(buyer => buyer.ownerId);
  const earlier = await CreditTransaction.aggregate<{ _id: { ownerType: string; ownerId: string } }>([
    {
      $match: {
        type: 'purchase',
        status: 'completed',
        createdAt: { $lt: before },
        $or: [
          { ownerType: 'User', ownerId: { $in: byType('user') } },
          { ownerType: 'Organization', ownerId: { $in: byType('organization') } },
        ],
      },
    },
    { $group: { _id: { ownerType: '$ownerType', ownerId: '$ownerId' } } },
  ]).option({ maxTimeMS: PAYMENTS_READ_MAX_TIME_MS });
  return earlier.length;
}

/** Day buckets up to ~3 months, month buckets beyond. */
export const seriesBucketFor = (from: string, to: string): 'day' | 'month' =>
  daysBetween(from, to) <= 92 ? 'day' : 'month';

async function paymentsSeries(
  scope: PaymentsScope,
  window: PaymentsWindow,
  bucket: 'day' | 'month'
): Promise<PaymentsSeriesPoint[]> {
  const rows = await aggregatePayments<{ _id: { date: string; currency: string; kind: PaymentKind }; amount: number }>(
    { ...scope, minAmount: undefined, maxAmount: undefined },
    window,
    { invoiceTypes: [INVOICE_PAID] },
    [
      { $match: { outcome: 'completed' } },
      {
        $group: {
          _id: {
            date: {
              $dateToString: {
                date: '$occurredAt',
                format: bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-01',
                timezone: 'UTC',
              },
            },
            currency: '$currency',
            kind: '$kind',
          },
          amount: { $sum: '$amount' },
        },
      },
    ]
  );
  const points = new Map<string, PaymentsSeriesPoint>();
  for (const row of rows) {
    const key = `${row._id.date}:${row._id.currency}`;
    const point = points.get(key) ?? {
      date: row._id.date,
      currency: row._id.currency,
      subscription: 0,
      creditPurchase: 0,
    };
    if (row._id.kind === 'subscription') point.subscription += row.amount;
    else point.creditPurchase += row.amount;
    points.set(key, point);
  }
  return [...points.values()].sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency));
}

/** The summary strip, payer and buyer breakdowns, the previous period of the same length, and the series. */
export async function adminPaymentsSummary(
  filter: AdminPaymentsFilter,
  now = new Date()
): Promise<AdminPaymentsSummaryResponse> {
  const window = resolvePaymentsWindow(filter, now);
  const previousRange = previousPaymentsWindow(window.from, window.to);
  const previousWindow = resolvePaymentsWindow(previousRange, now);
  const scope = await toScope(filter);
  const bucket = seriesBucketFor(window.from, window.to);
  const recordedFrom = await billingEventsRecordedFrom();
  const [current, previous, series] = await Promise.all([
    paymentsPeriodSummary(filter, scope, window, recordedFrom),
    paymentsPeriodSummary(filter, scope, previousWindow, recordedFrom),
    paymentsSeries(scope, window, bucket),
  ]);
  return { current, previous, bucket, series, searchTruncated: scope.search.truncated };
}
