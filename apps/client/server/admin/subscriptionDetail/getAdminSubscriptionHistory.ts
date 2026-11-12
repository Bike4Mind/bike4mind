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
// Every customer.subscription.* projection stores the item quantity (server/billing/billingEventStore.ts).
const SEAT_EVENT_TYPES = [
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

export type LedgerGrant = { at: Date; credits: number };

/**
 * Cycles from grants (oldest first): each grant opens a cycle that the next one closes; the last runs to
 * `windowEnd`. Grants written in the same millisecond are one cycle. `usedByStart` is keyed by start time (ms).
 */
export function buildCreditCycles(
  grants: readonly LedgerGrant[],
  windowEnd: Date,
  usedByStart: ReadonlyMap<number, number>,
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
      used: usedByStart.get(grant.at.getTime()) ?? 0,
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
  'subscriptionId' | 'ownerType' | 'ownerId' | 'status' | 'source' | 'createdAt' | 'periodEndsAt' | 'canceledAt'
>;

const creditCyclesOf = async (
  doc: HistoryDoc,
  now: Date
): Promise<Pick<AdminSubscriptionHistory, 'creditCycles' | 'creditCyclesTruncated'>> => {
  const ownerId = doc.ownerId;
  const ownerType = doc.ownerType === 'User' ? CreditHolderType.User : CreditHolderType.Organization;
  const terminal = isTerminalSubscriptionStatus(doc.status);
  const endedAt = doc.periodEndsAt ?? doc.canceledAt;
  const windowEnd = terminal && endedAt && endedAt < now ? endedAt : now;
  const createdAt: Record<string, Date> = { $lt: windowEnd };
  if (doc.createdAt) createdAt.$gte = new Date(doc.createdAt.getTime() - FIRST_GRANT_GRACE_MS);

  const rows = await CreditTransaction.find({
    $and: [
      // Must repeat the partial filter of credit_tx_owner_balance_events for the planner to use it.
      { ownerId, ownerType, type: { $in: [...CREDIT_BALANCE_EVENT_TYPES] } },
      { type: 'subscription', createdAt },
    ],
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_CREDIT_CYCLES + 1)
    .select('credits createdAt')
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<{ credits: number; createdAt: Date }[]>();
  if (rows.length === 0) return { creditCycles: [], creditCyclesTruncated: false };

  const truncated = rows.length > MAX_CREDIT_CYCLES;
  const grants = rows
    .slice(0, MAX_CREDIT_CYCLES)
    .reverse()
    .map(row => ({ at: row.createdAt, credits: row.credits }));
  const starts = [...new Set(grants.map(grant => grant.at.getTime()))];
  // $bucket boundaries must strictly increase, and the last cycle needs a nonzero span.
  const end = new Date(Math.max(windowEnd.getTime(), (starts.at(-1) ?? 0) + 1));
  const buckets = await CreditTransaction.aggregate<{ _id: Date | string; used: number }>([
    {
      $match: {
        ownerId,
        ownerType,
        type: { $in: [...LEDGER_USAGE_TRANSACTION_TYPES] },
        createdAt: { $gte: new Date(starts[0]), $lt: end },
      },
    },
    {
      $bucket: {
        groupBy: '$createdAt',
        boundaries: [...starts.map(start => new Date(start)), end],
        default: 'outside',
        // Usage rows are stored negative.
        output: { used: { $sum: { $abs: '$credits' } } },
      },
    },
  ]).option({ maxTimeMS: READ_MAX_TIME_MS });
  const usedByStart = new Map(
    buckets.filter(bucket => bucket._id instanceof Date).map(bucket => [(bucket._id as Date).getTime(), bucket.used])
  );
  return {
    creditCycles: buildCreditCycles(grants, end, usedByStart, !terminal),
    creditCyclesTruncated: truncated,
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
    .select('subscriptionId ownerType ownerId status source createdAt periodEndsAt canceledAt')
    .maxTimeMS(READ_MAX_TIME_MS)
    .lean<HistoryDoc>();
  if (!doc) return null;
  const [credits, seatChanges] = await Promise.all([creditCyclesOf(doc, now), seatChangesOf(doc)]);
  return { ...credits, seatChanges };
}
