import { BillingEventModel, CREDIT_BALANCE_EVENT_TYPES, CreditTransaction, mongoose } from '@bike4mind/database';
import { CreditHolderType, LEDGER_USAGE_TRANSACTION_TYPES } from '@bike4mind/common';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import {
  MAX_CREDIT_CYCLES,
  isCompSubscription,
  isTerminalSubscriptionStatus,
  type AdminSubscriptionCreditCycle,
  type AdminSubscriptionHistory,
  type AdminSubscriptionSeatChange,
} from '@client/app/utils/adminSubscriptionDetail';
import type { SubscriptionDoc } from '../subscriptionsList/listAdminSubscriptions';

const READ_MAX_TIME_MS = 10_000;
// The first grant can be written moments before the row it pays for, on the same invoice.payment_succeeded.
const FIRST_GRANT_GRACE_MS = 60 * 60 * 1000;
const MAX_SEAT_EVENTS = 500;
const EXTRA_GRANT_FILTERS = [{ 'metadata.source': 'admin_topup' }, { 'metadata.type': 'subscription_seat_increase' }];
// Every customer.subscription.* projection stores the item quantity (server/billing/billingEventStore.ts).
const SEAT_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

export type LedgerGrant = { at: Date; credits: number };

/**
 * Cycles from grants (oldest first): each grant opens a cycle that the next one closes; the last runs to
 * `windowEnd`. Grants written in the same millisecond are one cycle. `usedByStart` is keyed by start time (ms); `null` when usage could not be totaled.
 */
export function buildCreditCycles(
  grants: readonly LedgerGrant[],
  windowEnd: Date,
  usedByStart: ReadonlyMap<number, number> | null,
  ongoing: boolean
): AdminSubscriptionCreditCycle[] {
  const merged: LedgerGrant[] = [];
  for (const grant of grants) {
    const last = merged.at(-1);
    if (last && last.at.getTime() === grant.at.getTime()) last.credits += grant.credits;
    else merged.push({ at: grant.at, credits: grant.credits });
  }
  return merged.map((grant, index) => {
    const next = merged[index + 1];
    const end = next ? next.at : windowEnd;
    return {
      start: grant.at.toISOString(),
      end: end.toISOString(),
      granted: grant.credits,
      used: usedByStart ? (usedByStart.get(grant.at.getTime()) ?? 0) : null,
      current: !next && ongoing,
    };
  });
}

/** Oldest first, with consecutive repeats of the same quantity dropped. */
export function seatChangesFrom(events: readonly { at: Date; quantity: number }[]): AdminSubscriptionSeatChange[] {
  const changes: AdminSubscriptionSeatChange[] = [];
  for (const event of events) {
    if (changes.at(-1)?.quantity === event.quantity) continue;
    changes.push({ at: event.at.toISOString(), quantity: event.quantity });
  }
  return changes;
}

type HistoryDoc = Pick<
  SubscriptionDoc,
  | 'subscriptionId'
  | 'ownerType'
  | 'ownerId'
  | 'status'
  | 'source'
  | 'createdAt'
  | 'periodEndsAt'
  | 'canceledAt'
  | 'endedAt'
  | 'cancelAt'
  | 'cancelAtPeriodEnd'
>;

const MONGO_MAX_TIME_MS_EXPIRED = 50;

const isTimeLimitError = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === MONGO_MAX_TIME_MS_EXPIRED;

const historyWindowEnd = async (doc: HistoryDoc, now: Date): Promise<{ end: Date; estimated: boolean }> => {
  if (!isTerminalSubscriptionStatus(doc.status)) return { end: now, estimated: false };
  const comp = isCompSubscription({ source: doc.source ?? 'stripe', subscriptionId: doc.subscriptionId });
  const deletion =
    !doc.endedAt && !comp && doc.subscriptionId
      ? await BillingEventModel.findOne({
          subscriptionId: doc.subscriptionId,
          ownerType: doc.ownerType === 'User' ? 'user' : 'organization',
          ownerId: doc.ownerId,
          type: 'customer.subscription.deleted',
          occurredAt: { $lte: now },
        })
          .sort({ occurredAt: -1, _id: -1 })
          .select('occurredAt')
          .maxTimeMS(READ_MAX_TIME_MS)
          .lean<{ occurredAt: Date }>()
      : null;
  // Stripe canceled_at can be the scheduling request, whereas ended_at is the effective end.
  const compEnd =
    doc.canceledAt && doc.periodEndsAt
      ? new Date(Math.min(doc.canceledAt.getTime(), doc.periodEndsAt.getTime()))
      : (doc.canceledAt ?? doc.periodEndsAt);
  const knownEnd =
    doc.endedAt ??
    deletion?.occurredAt ??
    (comp
      ? compEnd
      : (doc.cancelAt ??
        (doc.cancelAtPeriodEnd === true ? doc.periodEndsAt : doc.cancelAtPeriodEnd === false ? doc.canceledAt : null)));
  return {
    end: new Date(Math.min((knownEnd ?? doc.periodEndsAt ?? now).getTime(), now.getTime())),
    estimated: !knownEnd,
  };
};

const creditCyclesOf = async (
  doc: HistoryDoc,
  now: Date
): Promise<
  Pick<
    AdminSubscriptionHistory,
    'creditCycles' | 'creditCyclesTruncated' | 'creditUsageUnavailable' | 'creditWindowEndEstimated'
  >
> => {
  const ownerId = doc.ownerId;
  const ownerType = doc.ownerType === 'User' ? CreditHolderType.User : CreditHolderType.Organization;
  const terminal = isTerminalSubscriptionStatus(doc.status);
  const { end: windowEnd, estimated } = await historyWindowEnd(doc, now);
  const createdAt: Record<string, Date> = { $lt: windowEnd };
  if (doc.createdAt) createdAt.$gte = new Date(doc.createdAt.getTime() - FIRST_GRANT_GRACE_MS);

  const rows = await CreditTransaction.find({
    $and: [
      // Must repeat the partial filter of credit_tx_owner_balance_events for the planner to use it.
      { ownerId, ownerType, type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] } },
      { type: 'subscription', createdAt, $nor: EXTRA_GRANT_FILTERS },
    ],
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_CREDIT_CYCLES + 1)
    .select('credits createdAt')
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<{ credits: number; createdAt: Date }[]>();
  const emptyHistory = {
    creditCycles: [],
    creditCyclesTruncated: false,
    creditUsageUnavailable: false,
    creditWindowEndEstimated: estimated,
  };
  const syntheticCompCycle =
    rows.length === 0 &&
    !!doc.createdAt &&
    doc.createdAt < windowEnd &&
    isCompSubscription({ source: doc.source ?? 'stripe', subscriptionId: doc.subscriptionId });
  if (rows.length === 0 && !syntheticCompCycle) return emptyHistory;

  const truncated = rows.length > MAX_CREDIT_CYCLES;
  const grants = rows
    .slice(0, MAX_CREDIT_CYCLES)
    .reverse()
    .map(row => ({ at: row.createdAt, credits: row.credits }));
  if (syntheticCompCycle && doc.createdAt) grants.push({ at: doc.createdAt, credits: 0 });
  const starts = [...new Set(grants.map(grant => grant.at.getTime()))];
  // Keep the final cycle nonempty even when its grant shares the snapshot timestamp.
  const end = new Date(Math.max(windowEnd.getTime(), (starts.at(-1) ?? 0) + 1));
  // DocumentDB 5 supports $group/$cond, but not $bucket. At most twelve starts keeps this bounded.
  type CycleStartExpression = Date | { $cond: [{ $gte: [string, Date] }, Date, CycleStartExpression] };
  const cycleStart = starts
    .slice(1)
    .reduce<CycleStartExpression>(
      (earlier, start) => ({ $cond: [{ $gte: ['$createdAt', new Date(start)] }, new Date(start), earlier] }),
      new Date(starts[0])
    );
  // Extras do not open cycles or consume the boundary limit. A failed grant read must not understate grants.
  const extras = await CreditTransaction.aggregate<{ _id: Date; credits: number }>([
    {
      $match: {
        ownerId,
        ownerType,
        type: 'subscription',
        $or: EXTRA_GRANT_FILTERS,
        createdAt: { $gte: new Date(starts[0]), $lt: end },
      },
    },
    { $group: { _id: cycleStart, credits: { $sum: '$credits' } } },
  ]).option({ maxTimeMS: READ_MAX_TIME_MS });
  if (syntheticCompCycle && extras.length === 0) return emptyHistory;
  const extraByStart = new Map(extras.map(bucket => [bucket._id.getTime(), bucket.credits]));
  let buckets: { _id: Date; used: number }[] | null;
  try {
    buckets = await CreditTransaction.aggregate<{ _id: Date; used: number }>([
      {
        $match: {
          ownerId,
          ownerType,
          type: { $in: [...LEDGER_USAGE_TRANSACTION_TYPES] },
          createdAt: { $gte: new Date(starts[0]), $lt: end },
        },
      },
      {
        $group: {
          _id: cycleStart,
          // Usage rows are stored negative.
          used: { $sum: { $abs: '$credits' } },
        },
      },
    ]).option({ maxTimeMS: READ_MAX_TIME_MS });
  } catch (error) {
    if (!isTimeLimitError(error)) throw error;
    buckets = null;
  }
  const usedByStart = buckets ? new Map(buckets.map(bucket => [bucket._id.getTime(), bucket.used])) : null;
  return {
    creditCycles: buildCreditCycles(grants, end, usedByStart, !terminal).map(cycle => ({
      ...cycle,
      granted: cycle.granted + (extraByStart.get(Date.parse(cycle.start)) ?? 0),
    })),
    creditWindowEndEstimated: estimated,
    creditCyclesTruncated: truncated,
    creditUsageUnavailable: usedByStart === null,
  };
};

const seatChangesOf = async (doc: HistoryDoc): Promise<AdminSubscriptionSeatChange[] | null> => {
  if (doc.ownerType === 'User') return null;
  if (isCompSubscription({ source: doc.source ?? 'stripe', subscriptionId: doc.subscriptionId })) return [];
  const events = await BillingEventModel.find({
    subscriptionId: doc.subscriptionId,
    type: { $in: SEAT_EVENT_TYPES },
    'data.quantity': { $type: 'number' },
  })
    .sort({ occurredAt: -1, _id: -1 })
    .limit(MAX_SEAT_EVENTS)
    .select('occurredAt data.quantity')
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<{ occurredAt: Date; data: { quantity: number } }[]>();
  return seatChangesFrom(events.reverse().map(event => ({ at: event.occurredAt, quantity: event.data.quantity })));
};

/** The detail page's chart history, or null for an id that is not an ObjectId or names no subscription. */
export async function getAdminSubscriptionHistory(
  id: string,
  now: Date = new Date()
): Promise<AdminSubscriptionHistory | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const doc = await Subscription.findById(id)
    .select(
      'subscriptionId ownerType ownerId status source createdAt periodEndsAt canceledAt endedAt cancelAt cancelAtPeriodEnd'
    )
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<HistoryDoc>();
  if (!doc) return null;
  const [credits, seatChanges] = await Promise.all([creditCyclesOf(doc, now), seatChangesOf(doc)]);
  return { ...credits, seatChanges };
}
