import { CreditHolderType, CreditPurchaseStatus } from '@bike4mind/common';
import { CREDIT_BALANCE_EVENT_TYPES, CreditTransaction, Organization, StripeDisputeModel } from '@bike4mind/database';
import { resolveSubscriptionSource, SubscriptionOwnerType, SubscriptionSource } from '../lib/subscriptions/types';
import { Subscription } from '../models/Subscription';
import { UNPAID_SUBSCRIPTION_STATUSES } from './activationFunnel';

/**
 * Each person's own Stripe payments, for the acquisition section's conversion metrics: completed credit-pack
 * purchases (one per payment intent) and Stripe-billed subscriptions. A credit purchase is marked reversed when
 * refunded or disputed; a subscription only when disputed, since a refund is recorded on credit purchases
 * alone. Payments on an organization the person owns only set `orgBuyerAt`; they never enter the
 * personal subscription/credit split.
 */

const DAY_MS = 86_400_000;

export type LedgerPaymentKind = 'subscription' | 'credit';

export type LedgerPayment = {
  kind: LedgerPaymentKind;
  at: Date;
  /** Under an open or lost dispute, or (credit purchases only) refunded. */
  reversed: boolean;
  subscription?: {
    status: string;
    periodStartsAt?: Date;
    periodEndsAt?: Date;
    interval?: string;
    intervalCount?: number;
    trialEndsAt?: Date;
    canceledAt?: Date;
  };
};

export type PaymentLedger = {
  /** Personal payments, earliest first; a subscription sorts before a credit purchase at the same instant. */
  payments: LedgerPayment[];
  /** Earliest payment on an organization this person is the billing owner of, if any. */
  orgBuyerAt: Date | null;
};

type PurchaseRow = {
  _id: unknown;
  ownerId: string;
  createdAt: Date;
  stripePaymentIntentId?: string | null;
  reversedAt?: Date | null;
};
type SubscriptionRow = {
  ownerType: SubscriptionOwnerType;
  ownerId: string;
  createdAt: Date;
  status: string;
  source?: SubscriptionSource;
  subscriptionId?: string;
  periodStartsAt?: Date;
  periodEndsAt?: Date;
  interval?: string;
  intervalCount?: number;
  trialEndsAt?: Date;
  canceledAt?: Date;
};
type DisputeRow = {
  paymentIntentId?: string | null;
  subject: string;
  subjectId?: string | null;
  state: string;
  stripeStatus?: string;
  openedAt: Date;
  closedAt?: Date | null;
  resolution?: { outcome?: string } | null;
};

// A dispute Stripe closed as anything but won or lost keeps state 'open' for an admin (StripeDisputeModel
// recordClosed), so `closedAt` and Stripe's own status decide whether it is still pending.
const countsAsReversal = (dispute: DisputeRow) =>
  dispute.resolution?.outcome === 'lost' ||
  dispute.stripeStatus === 'lost' ||
  (dispute.state === 'open' && !dispute.closedAt);

// A trial collects its first payment when it ends, and never when it was cancelled before then.
// Null when no payment has been collected before `until`.
const firstChargeAt = (sub: SubscriptionRow, until: Date): Date | null => {
  const createdAt = new Date(sub.createdAt);
  const trialEnd = sub.trialEndsAt && new Date(sub.trialEndsAt) > createdAt ? new Date(sub.trialEndsAt) : null;
  if (trialEnd && sub.canceledAt && new Date(sub.canceledAt) <= trialEnd) return null;
  if (trialEnd && trialEnd >= until) return null;
  return trialEnd ?? createdAt;
};

const purchasesOf = (ownerType: CreditHolderType, ownerIds: string[], until: Date, maxTimeMS: number) =>
  CreditTransaction.find({
    $and: [
      // Must repeat the partial filter of credit_tx_owner_balance_events for the planner to use it.
      { ownerId: { $in: ownerIds }, ownerType, type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] } },
      { type: 'purchase', status: CreditPurchaseStatus.Completed, createdAt: { $lt: until } },
    ],
  })
    .select('ownerId createdAt stripePaymentIntentId reversedAt')
    .maxTimeMS(maxTimeMS)
    .lean<PurchaseRow[]>();

/**
 * The payment ledger of every id in `userIds`, from payments made before `until`. Users with no payment
 * get an empty ledger.
 */
export async function loadPaymentLedger(
  userIds: readonly string[],
  { until, maxTimeMS }: { until: Date; maxTimeMS: () => number }
): Promise<Map<string, PaymentLedger>> {
  const ids = [...userIds];
  const ledgers = new Map<string, PaymentLedger>(ids.map(id => [id, { payments: [], orgBuyerAt: null }]));
  if (ids.length === 0) return ledgers;

  const [purchases, subscriptions, ownedOrganizations] = await Promise.all([
    purchasesOf(CreditHolderType.User, ids, until, maxTimeMS()),
    Subscription.find({
      ownerType: SubscriptionOwnerType.User,
      ownerId: { $in: ids },
      status: { $nin: UNPAID_SUBSCRIPTION_STATUSES },
      createdAt: { $lt: until },
    })
      .select(
        'ownerType ownerId createdAt status source subscriptionId periodStartsAt periodEndsAt interval intervalCount trialEndsAt canceledAt'
      )
      .maxTimeMS(maxTimeMS())
      .lean<SubscriptionRow[]>(),
    Organization.find({ userId: { $in: ids } })
      .select('_id userId')
      .maxTimeMS(maxTimeMS())
      .lean<{ _id: unknown; userId: string }[]>(),
  ]);

  const ownerOfOrganization = new Map(ownedOrganizations.map(org => [String(org._id), org.userId]));
  const orgIds = [...ownerOfOrganization.keys()];
  const paymentIntentIds = [
    ...new Set(purchases.map(row => row.stripePaymentIntentId).filter((pi): pi is string => !!pi)),
  ];
  const [orgPurchases, orgSubscriptions, disputes] = await Promise.all([
    orgIds.length > 0 ? purchasesOf(CreditHolderType.Organization, orgIds, until, maxTimeMS()) : [],
    orgIds.length > 0
      ? Subscription.find({
          ownerType: SubscriptionOwnerType.Organization,
          ownerId: { $in: orgIds },
          status: { $nin: UNPAID_SUBSCRIPTION_STATUSES },
          createdAt: { $lt: until },
        })
          .select('ownerType ownerId createdAt status source subscriptionId trialEndsAt canceledAt')
          .maxTimeMS(maxTimeMS())
          .lean<SubscriptionRow[]>()
      : [],
    // The dispute collection is small; maxTimeMS bounds the unindexed $or.
    StripeDisputeModel.find({
      $or: [
        ...(paymentIntentIds.length > 0 ? [{ paymentIntentId: { $in: paymentIntentIds } }] : []),
        { subject: 'user', subjectId: { $in: ids } },
      ],
    })
      .select('paymentIntentId subject subjectId state stripeStatus openedAt closedAt resolution')
      .maxTimeMS(maxTimeMS())
      .lean<DisputeRow[]>(),
  ]);

  const reversingDisputes = disputes.filter(countsAsReversal);
  const disputedIntents = new Set(reversingDisputes.map(d => d.paymentIntentId).filter(Boolean));
  const purchaseIntents = new Set(paymentIntentIds);
  // The webhook files a credit-purchase dispute under the user too; it already reverses that purchase, so
  // only a user dispute on no known purchase is held against the subscription.
  const userDisputesOpened = new Map<string, Date[]>();
  for (const dispute of reversingDisputes) {
    if (dispute.subject !== 'user' || !dispute.subjectId) continue;
    if (dispute.paymentIntentId && purchaseIntents.has(dispute.paymentIntentId)) continue;
    const list = userDisputesOpened.get(dispute.subjectId) ?? [];
    list.push(new Date(dispute.openedAt));
    userDisputesOpened.set(dispute.subjectId, list);
  }

  // The unique sparse index on stripePaymentIntentId keeps one row per intent, so this merge is only a
  // safeguard; legacy rows without an intent stand alone.
  const byIntent = new Map<string, { ownerId: string; at: Date; reversed: boolean }>();
  for (const row of purchases) {
    const key = row.stripePaymentIntentId || `row:${String(row._id)}`;
    const at = new Date(row.createdAt);
    const reversed =
      !!row.reversedAt || (!!row.stripePaymentIntentId && disputedIntents.has(row.stripePaymentIntentId));
    const seen = byIntent.get(key);
    if (!seen) byIntent.set(key, { ownerId: row.ownerId, at, reversed });
    else {
      if (at < seen.at) seen.at = at;
      seen.reversed ||= reversed;
    }
  }
  for (const purchase of byIntent.values()) {
    ledgers.get(purchase.ownerId)?.payments.push({ kind: 'credit', at: purchase.at, reversed: purchase.reversed });
  }

  const chargedSubscriptions = subscriptions.flatMap(sub => {
    if (resolveSubscriptionSource(sub) !== SubscriptionSource.Stripe) return [];
    const at = firstChargeAt(sub, until);
    return at ? [{ sub, at }] : [];
  });
  // A user dispute names no subscription, so it is held against the latest one charged before it opened that
  // no earlier dispute already took.
  const disputedSubscriptions = new Set<SubscriptionRow>();
  for (const [ownerId, openedDates] of userDisputesOpened) {
    for (const openedAt of [...openedDates].sort((a, b) => a.getTime() - b.getTime())) {
      let latest: { sub: SubscriptionRow; at: Date } | undefined;
      for (const charged of chargedSubscriptions) {
        if (charged.sub.ownerId !== ownerId || charged.at > openedAt) continue;
        if (disputedSubscriptions.has(charged.sub)) continue;
        if (!latest || charged.at > latest.at) latest = charged;
      }
      if (latest) disputedSubscriptions.add(latest.sub);
    }
  }

  for (const { sub, at } of chargedSubscriptions) {
    ledgers.get(sub.ownerId)?.payments.push({
      kind: 'subscription',
      at,
      reversed: disputedSubscriptions.has(sub),
      subscription: {
        status: sub.status,
        periodStartsAt: sub.periodStartsAt,
        periodEndsAt: sub.periodEndsAt,
        interval: sub.interval,
        intervalCount: sub.intervalCount,
        trialEndsAt: sub.trialEndsAt,
        canceledAt: sub.canceledAt,
      },
    });
  }

  const orgPaidAt = [
    ...orgPurchases.map(row => ({ ownerId: row.ownerId, at: new Date(row.createdAt) })),
    ...orgSubscriptions.flatMap(sub => {
      const at = resolveSubscriptionSource(sub) === SubscriptionSource.Stripe ? firstChargeAt(sub, until) : null;
      return at ? [{ ownerId: sub.ownerId, at }] : [];
    }),
  ];
  for (const { ownerId, at } of orgPaidAt) {
    const ledger = ledgers.get(ownerOfOrganization.get(ownerId) ?? '');
    if (ledger && (!ledger.orgBuyerAt || at < ledger.orgBuyerAt)) ledger.orgBuyerAt = at;
  }

  for (const ledger of ledgers.values()) {
    ledger.payments.sort(
      (a, b) => a.at.getTime() - b.at.getTime() || (a.kind === b.kind ? 0 : a.kind === 'subscription' ? -1 : 1)
    );
  }
  return ledgers;
}

export const utcDayStart = (date: Date) => Date.parse(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);

/** Whether `paidAt` falls on the signup's UTC day or within `windowDays` UTC days after it. */
export function paidWithinDays(signupAt: Date, paidAt: Date, windowDays: number): boolean {
  const days = (utcDayStart(paidAt) - utcDayStart(signupAt)) / DAY_MS;
  return days >= 0 && days <= windowDays;
}

export type FirstPaid = { kind: LedgerPaymentKind; at: Date; reversed: boolean; both: boolean };

/**
 * The first personal payment inside the conversion window, or null. `both` is true when the other kind was
 * also paid inside the window, so a buyer is counted once whichever came first. Reversals do not undo the
 * conversion itself, matching the activation funnel's paid step.
 */
export function classifyFirstPaid(
  ledger: PaymentLedger | undefined,
  signupAt: Date,
  windowDays: number
): FirstPaid | null {
  const inWindow = (ledger?.payments ?? []).filter(payment => paidWithinDays(signupAt, payment.at, windowDays));
  const first = inWindow[0];
  if (!first) return null;
  return {
    kind: first.kind,
    at: first.at,
    reversed: first.reversed,
    both: inWindow.some(payment => payment.kind !== first.kind),
  };
}
