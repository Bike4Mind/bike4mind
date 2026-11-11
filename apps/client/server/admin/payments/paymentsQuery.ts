import {
  BILLING_EVENT_PAYMENT_FOLLOW_UP_TYPES,
  BillingEventModel,
  CreditTransaction,
  Organization,
  User,
  mongoose,
} from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import {
  CREDIT_PURCHASE_CURRENCY,
  type AdminPaymentsFilter,
  type PaymentKind,
  type PaymentOwnerType,
  type PaymentStatus,
} from '@bike4mind/server-utils/app/utils/adminPayments';

/**
 * Builds the admin Payments report's reads over its two sources:
 * - credit purchases: CreditTransaction rows with `type: 'purchase'` (amount in cents, sold in USD only);
 * - subscription payments: BillingEvent rows for `invoice.payment_succeeded` / `invoice.payment_failed`,
 *   written by the Stripe webhook (billingEventStore.ts) and deduplicated per invoice.
 * The `subscription` ledger rows are deliberately not read: they carry credits, never money, and admin
 * top-ups write the same type.
 */

type Condition = Record<string, unknown>;
/** A stage that may also run inside `$facet` and `$unionWith`, which most of these do. */
export type Stage = mongoose.PipelineStage.FacetPipelineStage;

/** ms. A report read that runs past this is a filter the indexes cannot serve; fail it rather than queue. */
export const PAYMENTS_READ_MAX_TIME_MS = 15_000;
/** Owners one text search may resolve to. Past this the search is reported as truncated. */
export const PAYMENTS_OWNER_SEARCH_LIMIT = 500;

export const INVOICE_PAID = 'invoice.payment_succeeded';
export const INVOICE_FAILED = 'invoice.payment_failed';
export const CHARGE_REFUNDED = 'charge.refunded';
export const DISPUTE_CREATED = 'charge.dispute.created';
export const DISPUTE_CLOSED = 'charge.dispute.closed';

export type PaymentsWindow = { start: Date; end: Date };

/** What the free-text search resolved to; `owners` and the references are alternatives, never combined. */
export type ResolvedPaymentsSearch = {
  owners?: { userIds: string[]; organizationIds: string[] };
  paymentIntentId?: string;
  invoiceId?: string;
  subscriptionId?: string;
  truncated: boolean;
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

const idStrings = (docs: { _id: unknown }[]) => docs.map(doc => String(doc._id));

// One past the limit, so a truncated search is detectable.
const userIdsMatching = async (query: Condition) =>
  idStrings(
    await User.find(query)
      .select('_id')
      .limit(PAYMENTS_OWNER_SEARCH_LIMIT + 1)
      .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
      .lean()
  );

const organizationIdsMatching = async (query: Condition) =>
  idStrings(
    await Organization.find(query)
      .select('_id')
      .limit(PAYMENTS_OWNER_SEARCH_LIMIT + 1)
      .maxTimeMS(PAYMENTS_READ_MAX_TIME_MS)
      .lean()
  );

/**
 * Resolves the search before any payment read, so those reads stay on their date indexes. Stripe references
 * match exactly; anything else matches users by name, username or email and organizations by name or by
 * their billing owner.
 */
export async function resolvePaymentsSearch(search: string | undefined): Promise<ResolvedPaymentsSearch> {
  if (!search) return { truncated: false };
  if (search.startsWith('pi_')) return { paymentIntentId: search, truncated: false };
  if (search.startsWith('in_')) return { invoiceId: search, truncated: false };
  if (search.startsWith('sub_')) return { subscriptionId: search, truncated: false };
  if (OBJECT_ID.test(search)) {
    const id = search.toLowerCase();
    return { owners: { userIds: [id], organizationIds: [id] }, truncated: false };
  }

  const userQuery = search.startsWith('cus_')
    ? { stripeCustomerId: search }
    : {
        $or: ['name', 'username', 'email'].map(field => ({ [field]: { $regex: escapeRegex(search), $options: 'i' } })),
      };
  const userIds = await userIdsMatching(userQuery);
  const organizationQuery = search.startsWith('cus_')
    ? { stripeCustomerId: search }
    : {
        $or: [
          { name: { $regex: escapeRegex(search), $options: 'i' } },
          { userId: { $in: userIds.slice(0, PAYMENTS_OWNER_SEARCH_LIMIT) } },
        ],
      };
  const organizationIds = await organizationIdsMatching(organizationQuery);
  return {
    owners: {
      userIds: userIds.slice(0, PAYMENTS_OWNER_SEARCH_LIMIT),
      organizationIds: organizationIds.slice(0, PAYMENTS_OWNER_SEARCH_LIMIT),
    },
    truncated: userIds.length > PAYMENTS_OWNER_SEARCH_LIMIT || organizationIds.length > PAYMENTS_OWNER_SEARCH_LIMIT,
  };
}

/** The filters both sources share, minus status (computed after the follow-up lookup) and kind. */
export type PaymentsScope = Pick<AdminPaymentsFilter, 'ownerType' | 'currency' | 'minAmount' | 'maxAmount' | 'kind'> & {
  search: ResolvedPaymentsSearch;
};

const LEDGER_OWNER_TYPE: Record<PaymentOwnerType, string> = { user: 'User', organization: 'Organization' };

const amountCondition = ({ minAmount, maxAmount }: PaymentsScope): Condition | undefined =>
  minAmount === undefined && maxAmount === undefined
    ? undefined
    : {
        ...(minAmount !== undefined && { $gte: minAmount }),
        ...(maxAmount !== undefined && { $lte: maxAmount }),
      };

/** Owner condition for one source; `ownerTypeOf` maps our owner type to the source's spelling. */
function ownerConditions(scope: PaymentsScope, ownerTypeOf: (type: PaymentOwnerType) => string): Condition[] {
  const types = scope.ownerType ? [scope.ownerType] : (['user', 'organization'] as const);
  const owners = scope.search.owners;
  if (!owners) return [{ ownerType: { $in: types.map(ownerTypeOf) } }];
  return [
    {
      $or: types.map(type => ({
        ownerType: ownerTypeOf(type),
        ownerId: { $in: type === 'user' ? owners.userIds : owners.organizationIds },
      })),
    },
  ];
}

/** False when the scope rules a source out entirely, so its branch is skipped instead of matching nothing. */
export function includesCreditPurchases(scope: PaymentsScope): boolean {
  if (scope.kind === 'subscription') return false;
  if (scope.currency && scope.currency !== CREDIT_PURCHASE_CURRENCY) return false;
  return !scope.search.invoiceId && !scope.search.subscriptionId;
}

export function includesSubscriptionPayments(scope: PaymentsScope): boolean {
  return scope.kind !== 'credit_purchase';
}

/** Purchase rows in the window. Must keep `type: 'purchase'` to use the partial purchases index. */
export function purchaseMatch(scope: PaymentsScope, window: PaymentsWindow, extra: Condition = {}): Condition {
  const amount = amountCondition(scope);
  return {
    $and: [
      { type: 'purchase', createdAt: { $gte: window.start, $lt: window.end } },
      ...ownerConditions(scope, type => LEDGER_OWNER_TYPE[type]),
      ...(amount ? [{ amount }] : []),
      ...(scope.search.paymentIntentId ? [{ stripePaymentIntentId: scope.search.paymentIntentId }] : []),
      extra,
    ],
  };
}

/** Invoice events in the window. */
export function invoiceMatch(scope: PaymentsScope, window: PaymentsWindow, types: readonly string[]): Condition {
  const amount = amountCondition(scope);
  return {
    $and: [
      { type: { $in: [...types] }, occurredAt: { $gte: window.start, $lt: window.end } },
      ...ownerConditions(scope, type => type),
      // A $0 invoice (trial, 100% coupon) moved no money.
      { amount: { $gt: 0, ...amount } },
      ...(scope.currency ? [{ currency: scope.currency }] : []),
      ...(scope.search.paymentIntentId ? [{ 'data.paymentIntentId': scope.search.paymentIntentId }] : []),
      ...(scope.search.invoiceId ? [{ 'data.invoiceId': scope.search.invoiceId }] : []),
      ...(scope.search.subscriptionId ? [{ subscriptionId: scope.search.subscriptionId }] : []),
    ],
  };
}

/** Refund and dispute events in the window, scoped to the same owners and currency. */
export function followUpMatch(scope: PaymentsScope, window: PaymentsWindow, type: string): Condition {
  return {
    $and: [
      { type, occurredAt: { $gte: window.start, $lt: window.end } },
      ...ownerConditions(scope, ownerType => ownerType),
      ...(scope.currency ? [{ currency: scope.currency }] : []),
      ...(scope.search.paymentIntentId ? [{ 'data.paymentIntentId': scope.search.paymentIntentId }] : []),
    ],
  };
}

/** One payment in the shape both sources are normalized to before they are merged. */
export type NormalizedPayment = {
  _id: mongoose.Types.ObjectId;
  kind: PaymentKind;
  occurredAt: Date;
  ownerType: PaymentOwnerType;
  ownerId: string;
  amount: number;
  currency: string;
  credits: number | null;
  paymentIntentId: string | null;
  invoiceId: string | null;
  subscriptionId: string | null;
  /** What the source says about the charge itself: completed, pending or failed. */
  outcome: 'completed' | 'pending' | 'failed';
  reversalReason: 'refunded' | 'dispute_lost' | null;
};

const purchaseProjection: Stage = {
  $project: {
    _id: 1,
    kind: { $literal: 'credit_purchase' },
    occurredAt: '$createdAt',
    ownerType: { $cond: [{ $eq: ['$ownerType', 'Organization'] }, 'organization', 'user'] },
    ownerId: 1,
    amount: { $ifNull: ['$amount', 0] },
    currency: { $literal: CREDIT_PURCHASE_CURRENCY },
    credits: '$credits',
    paymentIntentId: { $ifNull: ['$stripePaymentIntentId', null] },
    invoiceId: { $literal: null },
    subscriptionId: { $literal: null },
    outcome: { $ifNull: ['$status', 'completed'] },
    reversalReason: { $ifNull: ['$reversalReason', null] },
  },
};

/**
 * One row per invoice: Stripe can send several events for one invoice (a failed attempt, then the paid
 * one, or a redelivery under a new event id), so the latest outcome in the window wins.
 */
const invoiceStages = (match: Condition): Stage[] => [
  { $match: match },
  { $sort: { occurredAt: -1, _id: -1 } },
  { $group: { _id: { $ifNull: ['$data.invoiceId', '$stripeEventId'] }, event: { $first: '$$ROOT' } } },
  { $replaceRoot: { newRoot: '$event' } },
  {
    $project: {
      _id: 1,
      kind: { $literal: 'subscription' },
      occurredAt: 1,
      ownerType: 1,
      ownerId: 1,
      amount: 1,
      currency: 1,
      credits: { $literal: null },
      paymentIntentId: { $ifNull: ['$data.paymentIntentId', null] },
      invoiceId: { $ifNull: ['$data.invoiceId', null] },
      subscriptionId: 1,
      outcome: { $cond: [{ $eq: ['$type', INVOICE_PAID] }, 'completed', 'failed'] },
      reversalReason: { $literal: null },
    },
  },
];

const billingEventCollection = () => BillingEventModel.collection.collectionName;

/**
 * Runs `after` over the merged, normalized payments. Starts from whichever source the scope keeps, and
 * returns [] without a read when it keeps neither.
 */
export async function aggregatePayments<T>(
  scope: PaymentsScope,
  window: PaymentsWindow,
  options: { invoiceTypes: readonly string[]; purchaseExtra?: Condition },
  after: mongoose.PipelineStage[]
): Promise<T[]> {
  const withPurchases = includesCreditPurchases(scope);
  const withInvoices = includesSubscriptionPayments(scope);
  const invoices = invoiceStages(invoiceMatch(scope, window, options.invoiceTypes));

  if (withPurchases) {
    const pipeline: mongoose.PipelineStage[] = [
      { $match: purchaseMatch(scope, window, options.purchaseExtra) },
      purchaseProjection,
      ...(withInvoices ? [{ $unionWith: { coll: billingEventCollection(), pipeline: invoices } }] : []),
      ...after,
    ];
    return CreditTransaction.aggregate<T>(pipeline).option({
      maxTimeMS: PAYMENTS_READ_MAX_TIME_MS,
    });
  }
  if (!withInvoices) return [];
  return BillingEventModel.aggregate<T>([...invoices, ...after]).option({
    maxTimeMS: PAYMENTS_READ_MAX_TIME_MS,
    // The merged rows are sorted in memory; a two-year range can pass the 100 MB stage limit.
    allowDiskUse: true,
  });
}

/**
 * Joins each payment to the refund and dispute events of its payment intent and derives `status` and
 * `refundedAmount`. Stripe's `charge.refunded` amount is cumulative, so the largest one is the total so far.
 * A purchase reversed before the event store existed has only its ledger flag: a full refund or a lost
 * dispute.
 */
export const paymentStatusStages: Stage[] = [
  {
    $lookup: {
      from: BillingEventModel.collection.collectionName,
      let: { paymentIntentId: '$paymentIntentId' },
      pipeline: [
        {
          $match: {
            type: { $in: [...BILLING_EVENT_PAYMENT_FOLLOW_UP_TYPES] },
            $expr: {
              $and: [{ $ne: ['$$paymentIntentId', null] }, { $eq: ['$data.paymentIntentId', '$$paymentIntentId'] }],
            },
          },
        },
        { $project: { _id: 0, type: 1, amount: 1, status: '$data.status' } },
      ],
      as: 'followUps',
    },
  },
  {
    $addFields: {
      refundedByEvents: {
        $ifNull: [
          {
            $max: {
              $map: {
                input: { $filter: { input: '$followUps', cond: { $eq: ['$$this.type', CHARGE_REFUNDED] } } },
                in: '$$this.amount',
              },
            },
          },
          0,
        ],
      },
      disputeLost: {
        $anyElementTrue: [
          {
            $map: {
              input: '$followUps',
              in: { $and: [{ $eq: ['$$this.type', DISPUTE_CLOSED] }, { $eq: ['$$this.status', 'lost'] }] },
            },
          },
        ],
      },
      disputeOpened: { $in: [DISPUTE_CREATED, '$followUps.type'] },
      disputeClosed: { $in: [DISPUTE_CLOSED, '$followUps.type'] },
    },
  },
  {
    $addFields: {
      refundedAmount: {
        $max: ['$refundedByEvents', { $cond: [{ $eq: ['$reversalReason', 'refunded'] }, '$amount', 0] }],
      },
    },
  },
  {
    $addFields: {
      status: {
        $switch: {
          branches: [
            { case: { $eq: ['$outcome', 'pending'] }, then: 'pending' },
            { case: { $eq: ['$outcome', 'failed'] }, then: 'failed' },
            {
              case: { $or: ['$disputeLost', { $eq: ['$reversalReason', 'dispute_lost'] }] },
              then: 'dispute_lost',
            },
            { case: { $and: ['$disputeOpened', { $not: ['$disputeClosed'] }] }, then: 'disputed' },
            {
              case: { $and: [{ $gt: ['$refundedAmount', 0] }, { $gte: ['$refundedAmount', '$amount'] }] },
              then: 'refunded',
            },
            { case: { $gt: ['$refundedAmount', 0] }, then: 'partially_refunded' },
          ],
          default: 'succeeded',
        },
      },
      refundedAmount: { $cond: [{ $gt: ['$refundedAmount', 0] }, '$refundedAmount', null] },
    },
  },
  { $project: { followUps: 0, refundedByEvents: 0, disputeLost: 0, disputeOpened: 0, disputeClosed: 0 } },
];

export type PaymentWithStatus = NormalizedPayment & { status: PaymentStatus; refundedAmount: number | null };

export const PAYMENTS_SORT: Stage = { $sort: { occurredAt: -1, _id: -1 } };
