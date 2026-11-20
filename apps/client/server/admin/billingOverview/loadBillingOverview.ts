import {
  BillingEventModel,
  CREDIT_BALANCE_EVENT_TYPES,
  CreditTransaction,
  Organization,
  PendingCreditHoldModel,
  UsageEvent,
  User,
  CreditLot,
} from '@bike4mind/database';
import { CreditHolderType, NotFoundError } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { SubscriptionOwnerType, TERMINAL_SUBSCRIPTION_STATUSES } from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  BILLING_RANGE_DAYS,
  type BillingLink,
  type BillingOverview,
  type BillingOverviewQuery,
  type BillingUsageAttribution,
} from '@client/app/utils/adminBillingOverview';
import { toAdminSubscriptionRows, type SubscriptionDoc } from '../subscriptionsList/listAdminSubscriptions';
import { subscriptionPlanCatalog } from '../subscriptionsList/adminSubscriptionsQuery';
import {
  PAYMENT_RECORDS_LIMIT,
  buildActivity,
  fundingOfBalance,
  subscriptionStanding,
  summarizePayments,
  totalsByCurrency,
  type BillingEventRow,
  type DailyConsumptionRow,
  type IssuanceRow,
  type PurchaseRow,
} from './billingOverviewModel';

const DAY_MS = 86_400_000;
const ISSUANCE_TYPES = [
  'purchase',
  'subscription',
  'generic_add',
  'received_credit',
] as const satisfies readonly (typeof CREDIT_BALANCE_EVENT_TYPES)[number][];
// ms. Every read here is an indexed, owner-scoped range; one running past this is reported as unavailable.
const QUERY_MAX_TIME_MS = 8_000;
/** Rows one section reads; a window holding more is reported as truncated. */
const LEDGER_ROW_LIMIT = 500;
const BILLING_EVENT_LIMIT = 1_000;
const ATTRIBUTION_LIMIT = 20;
const SUBSCRIPTION_LIMIT = 10;

type Owner = {
  type: BillingOverviewQuery['ownerType'];
  id: string;
  name: string | null;
  internal: boolean;
  currentCredits: number;
};

type Section<T> = ({ status: 'ok' } & T) | { status: 'unavailable'; message: string };

const HOLDER_TYPE = { user: CreditHolderType.User, organization: CreditHolderType.Organization } as const;
const SUBSCRIPTION_OWNER = {
  user: SubscriptionOwnerType.User,
  organization: SubscriptionOwnerType.Organization,
} as const;

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const isoOrNull = (date: Date | null | undefined) => (date ? new Date(date).toISOString() : null);

async function loadOwner(query: BillingOverviewQuery): Promise<Owner> {
  if (query.ownerType === 'user') {
    const user = await User.findById(query.ownerId, {
      name: 1,
      email: 1,
      username: 1,
      isInternal: 1,
      currentCredits: 1,
    }).lean<{ name?: string; email?: string; username?: string; isInternal?: boolean; currentCredits?: number }>();
    if (!user) throw new NotFoundError('User not found');
    return {
      type: 'user',
      id: query.ownerId,
      name: user.name || user.email || user.username || null,
      internal: user.isInternal === true,
      currentCredits: user.currentCredits ?? 0,
    };
  }
  const organization = await Organization.findById(query.ownerId, { name: 1, currentCredits: 1 }).lean<{
    name?: string;
    currentCredits?: number;
  }>();
  if (!organization) throw new NotFoundError('Organization not found');
  return {
    type: 'organization',
    id: query.ownerId,
    name: organization.name || null,
    internal: false,
    currentCredits: organization.currentCredits ?? 0,
  };
}

/** Runs one section's reads; a failure is logged and reported in the section instead of failing the page. */
async function guarded<T>(name: string, logger: Logger, load: () => Promise<T>): Promise<Section<T>> {
  try {
    return { status: 'ok', ...(await load()) };
  } catch (error) {
    logger.error(`[BillingOverview] ${name} failed`, { error: error instanceof Error ? error.message : String(error) });
    return { status: 'unavailable', message: `The ${name} could not be loaded.` };
  }
}

async function loadSubscriptions(owner: Owner) {
  const base = { ownerType: SUBSCRIPTION_OWNER[owner.type], ownerId: owner.id };
  // Newest rows alone could all be ended, hiding an older live subscription, so live rows are read apart.
  const [recent, live] = await Promise.all([
    Subscription.find(base)
      .sort({ createdAt: -1 })
      .limit(SUBSCRIPTION_LIMIT)
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<SubscriptionDoc[]>(),
    Subscription.find({ ...base, status: { $nin: [...TERMINAL_SUBSCRIPTION_STATUSES] } })
      .sort({ createdAt: -1 })
      .limit(SUBSCRIPTION_LIMIT)
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<SubscriptionDoc[]>(),
  ]);
  const seen = new Set(recent.map(doc => String(doc._id)));
  const docs = [...recent, ...live.filter(doc => !seen.has(String(doc._id)))].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  );
  return toAdminSubscriptionRows(docs, subscriptionPlanCatalog());
}

async function loadCredits(owner: Owner) {
  const holderType = HOLDER_TYPE[owner.type];
  const [lots, holds] = await Promise.all([
    CreditLot.find({ ownerId: owner.id, ownerType: holderType })
      .sort({ expiresAt: 1 })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<Parameters<typeof fundingOfBalance>[0][number][]>(),
    PendingCreditHoldModel.aggregate<{ held: number; requests: number }>([
      {
        $match: {
          // A user's own holds also carry their userId, which is indexed.
          ...(owner.type === 'user' ? { userId: owner.id } : {}),
          ownerId: owner.id,
          ownerType: holderType,
          settledAt: { $exists: false },
        },
      },
      { $group: { _id: null, held: { $sum: { $max: [0, '$reservedCredits'] } }, requests: { $sum: 1 } } },
    ]).option({ maxTimeMS: QUERY_MAX_TIME_MS }),
  ]);
  return {
    available: owner.currentCredits,
    held: holds[0]?.held ?? 0,
    heldRequests: holds[0]?.requests ?? 0,
    funding: fundingOfBalance(lots, owner.currentCredits),
  };
}

type LedgerDoc = {
  _id: unknown;
  createdAt: Date;
  type: string;
  credits: number;
  amount?: number;
  status?: string;
  stripePaymentIntentId?: string;
  reversedAt?: Date | null;
  reversalReason?: string;
  reason?: string;
};

/** Balance-moving ledger rows (purchases, subscription credits, grants, transfers) in the window. */
async function loadLedger(owner: Owner, from: Date, to: Date) {
  const rows = await CreditTransaction.find({
    ownerId: owner.id,
    ownerType: HOLDER_TYPE[owner.type],
    // A subset of credit_tx_owner_balance_events' partial filter, so the read walks that index; deducts
    // and transfers out are left out so they cannot use up the row limit.
    type: { $in: [...ISSUANCE_TYPES] },
    createdAt: { $gte: from, $lt: to },
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(LEDGER_ROW_LIMIT + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<LedgerDoc[]>();
  const truncated = rows.length > LEDGER_ROW_LIMIT;
  const kept = rows.slice(0, LEDGER_ROW_LIMIT);
  const purchases: PurchaseRow[] = kept
    .filter(row => row.type === 'purchase')
    .map(row => ({
      id: String(row._id),
      createdAt: row.createdAt,
      credits: Math.abs(row.credits),
      amount: row.amount ?? 0,
      status: row.status ?? 'completed',
      stripePaymentIntentId: row.stripePaymentIntentId ?? null,
      reversedAt: row.reversedAt ?? null,
      reversalReason: row.reversalReason ?? null,
    }));
  const issuances: IssuanceRow[] = kept
    .filter(row => row.type !== 'purchase' || (row.status ?? 'completed') === 'completed')
    .map(row => ({
      id: String(row._id),
      createdAt: row.createdAt,
      type: row.type,
      credits: row.credits,
      stripePaymentIntentId: row.stripePaymentIntentId ?? null,
      reason: row.reason ?? null,
      reversed: !!row.reversedAt,
    }));
  return { purchases, issuances, truncated };
}

async function loadBillingEvents(owner: Owner, from: Date, to: Date) {
  const rows = await BillingEventModel.find({
    ownerType: owner.type,
    ownerId: owner.id,
    occurredAt: { $gte: from, $lt: to },
  })
    .sort({ occurredAt: -1, _id: -1 })
    .limit(BILLING_EVENT_LIMIT + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<(Omit<BillingEventRow, 'id'> & { _id: unknown })[]>();
  const events: BillingEventRow[] = rows.slice(0, BILLING_EVENT_LIMIT).map(({ _id, ...row }) => ({
    ...row,
    id: String(_id),
    data: row.data ?? {},
  }));
  return { events, truncated: rows.length > BILLING_EVENT_LIMIT };
}

/** When the stores began: the oldest stored row, read off an index. Null while a store is empty. */
async function recordedSince() {
  const [firstEvent, firstUsage] = await Promise.all([
    BillingEventModel.findOne({}, { createdAt: 1 })
      .sort({ _id: 1 })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<{ createdAt: Date }>(),
    UsageEvent.findOne({}, { createdAt: 1 })
      .sort({ createdAt: 1 })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<{ createdAt: Date }>(),
  ]);
  return { billingEvents: isoOrNull(firstEvent?.createdAt), usageEvents: isoOrNull(firstUsage?.createdAt) };
}

type UsageGroup = {
  _id: { ownerType?: string; ownerId?: string; userId?: string };
  credits: number;
  events: number;
  lastAt: Date | null;
};
type DayGroup = {
  _id: { day: string; ownerType?: string; ownerId?: string };
  credits: number;
  events: number;
  lastAt: Date;
};

async function namesOf(model: typeof User | typeof Organization, ids: string[]) {
  if (ids.length === 0) return new Map<string, string | null>();
  const docs = await (model as typeof Organization)
    .find({ _id: { $in: ids } }, { name: 1, email: 1, username: 1 })
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<{ _id: unknown; name?: string; email?: string; username?: string }[]>();
  return new Map(docs.map(doc => [String(doc._id), doc.name || doc.email || doc.username || null]));
}

/**
 * Charged usage in the window from usage events. For a user: grouped by who paid (their own balance,
 * each organization, each agent), never added together. For an organization: what it paid for, by member.
 */
async function loadUsage(owner: Owner, from: Date, to: Date) {
  const match =
    owner.type === 'user'
      ? { userId: owner.id, createdAt: { $gte: from, $lt: to } }
      : { ownerId: owner.id, ownerType: CreditHolderType.Organization, createdAt: { $gte: from, $lt: to } };
  const groupKey = owner.type === 'user' ? { ownerType: '$ownerType', ownerId: '$ownerId' } : { userId: '$userId' };
  const dayKey = {
    day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
    ...(owner.type === 'user' ? { ownerType: '$ownerType', ownerId: '$ownerId' } : {}),
  };
  const lastOkMatch =
    owner.type === 'user'
      ? { userId: owner.id, status: 'ok' }
      : { ownerId: owner.id, ownerType: CreditHolderType.Organization, status: 'ok' };

  const [groups, days, lastOk] = await Promise.all([
    UsageEvent.aggregate<UsageGroup>([
      { $match: match },
      {
        $group: {
          _id: groupKey,
          credits: { $sum: '$creditsCharged' },
          events: { $sum: 1 },
          lastAt: { $max: '$createdAt' },
        },
      },
      { $sort: { credits: -1 } },
      { $limit: ATTRIBUTION_LIMIT + 1 },
    ]).option({ maxTimeMS: QUERY_MAX_TIME_MS }),
    UsageEvent.aggregate<DayGroup>([
      { $match: match },
      {
        $group: {
          _id: dayKey,
          credits: { $sum: '$creditsCharged' },
          events: { $sum: 1 },
          lastAt: { $max: '$createdAt' },
        },
      },
    ]).option({ maxTimeMS: QUERY_MAX_TIME_MS }),
    UsageEvent.findOne(lastOkMatch, { createdAt: 1 })
      .sort({ createdAt: -1 })
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<{ createdAt: Date }>(),
  ]);

  const kept = groups.slice(0, ATTRIBUTION_LIMIT);
  const orgIds = new Set<string>();
  const userIds = new Set<string>();
  for (const group of [...kept, ...days]) {
    if (group._id.ownerType === CreditHolderType.Organization && group._id.ownerId) orgIds.add(group._id.ownerId);
    if ('userId' in group._id && group._id.userId) userIds.add(group._id.userId);
  }
  const [orgNames, userNames] = await Promise.all([namesOf(Organization, [...orgIds]), namesOf(User, [...userIds])]);

  const attribution: BillingUsageAttribution[] = kept.map(group => {
    const lastAt = isoOrNull(group.lastAt);
    if (owner.type === 'organization') {
      const actor = group._id.userId ?? null;
      return {
        billedTo: 'organization',
        billedToId: owner.id,
        billedToName: owner.name,
        actorUserId: actor,
        actorName: actor ? (userNames.get(actor) ?? null) : null,
        credits: group.credits,
        events: group.events,
        lastAt,
        link: actor
          ? ({ kind: 'userActivity', userId: actor, from: isoDay(from), to: isoDay(to) } satisfies BillingLink)
          : null,
      };
    }
    const ownerId = group._id.ownerId ?? '';
    const billedTo =
      group._id.ownerType === CreditHolderType.Organization
        ? 'organization'
        : group._id.ownerType === CreditHolderType.Agent
          ? 'agent'
          : 'user';
    return {
      billedTo,
      billedToId: ownerId,
      billedToName:
        billedTo === 'organization' ? (orgNames.get(ownerId) ?? null) : billedTo === 'user' ? owner.name : null,
      actorUserId: owner.id,
      actorName: owner.name,
      credits: group.credits,
      events: group.events,
      lastAt,
      link: billedTo === 'organization' ? { kind: 'organization', organizationId: ownerId } : null,
    };
  });

  const consumption: DailyConsumptionRow[] = days.map(group => {
    const billedToOrg =
      group._id.ownerType === CreditHolderType.Organization && group._id.ownerId
        ? (orgNames.get(group._id.ownerId) ?? 'an organization')
        : group._id.ownerType === CreditHolderType.Agent
          ? 'an agent'
          : null;
    return {
      day: group._id.day,
      lastAt: group.lastAt,
      credits: group.credits,
      events: group.events,
      billedToKey: `${group._id.ownerType ?? 'Organization'}:${group._id.ownerId ?? owner.id}`,
      billedToLabel: billedToOrg,
    };
  });

  return {
    lastSuccessfulAt: isoOrNull(lastOk?.createdAt),
    attribution,
    truncated: groups.length > ATTRIBUTION_LIMIT,
    consumption,
    link:
      owner.type === 'user'
        ? ({ kind: 'userActivity', userId: owner.id, from: isoDay(from), to: isoDay(to) } satisfies BillingLink)
        : null,
  };
}

const withSourceTruncation = <T extends { truncated: boolean }>(result: T, sourceTruncated: boolean): T => ({
  ...result,
  truncated: result.truncated || sourceTruncated,
});

/** Read-only: nothing here writes, notifies or calls Stripe. */
export async function loadBillingOverview(
  query: BillingOverviewQuery,
  logger: Logger,
  now = new Date()
): Promise<BillingOverview> {
  const owner = await loadOwner(query);
  const to = now;
  const from = new Date(now.getTime() - BILLING_RANGE_DAYS[query.range] * DAY_MS);

  const [subscriptionRows, credits, ledger, events, usage, since] = await Promise.all([
    guarded('subscriptions', logger, async () => ({ rows: await loadSubscriptions(owner) })),
    guarded('credit balance', logger, () => loadCredits(owner)),
    guarded('credit ledger', logger, () => loadLedger(owner, from, to)),
    guarded('Stripe events', logger, () => loadBillingEvents(owner, from, to)),
    guarded('usage', logger, () => loadUsage(owner, from, to)),
    guarded('coverage dates', logger, recordedSince),
  ]);

  const subscription: BillingOverview['subscription'] =
    subscriptionRows.status === 'ok'
      ? { status: 'ok', ...subscriptionStanding(subscriptionRows.rows) }
      : subscriptionRows;

  const localSubscriptionIds = new Map(
    subscriptionRows.status === 'ok' ? subscriptionRows.rows.map(row => [row.subscriptionId, row.id] as const) : []
  );

  // Payments need both sources: purchases live in the ledger, invoices, refunds and disputes in Stripe events.
  const firstFailure = [ledger, events].find(part => part.status !== 'ok');
  const paymentRecords =
    ledger.status === 'ok' && events.status === 'ok'
      ? summarizePayments(ledger.purchases, events.events, {
          ownerType: owner.type,
          ownerId: owner.id,
          localSubscriptionIds,
        })
      : null;

  const payments: BillingOverview['payments'] =
    paymentRecords && ledger.status === 'ok' && events.status === 'ok'
      ? {
          status: 'ok',
          totals: totalsByCurrency(paymentRecords),
          records: paymentRecords.slice(0, PAYMENT_RECORDS_LIMIT),
          truncated: ledger.truncated || events.truncated || paymentRecords.length > PAYMENT_RECORDS_LIMIT,
          eventsRecordedSince: since.status === 'ok' ? since.billingEvents : null,
          eventsCoverageUnknown: since.status !== 'ok',
        }
      : {
          status: 'unavailable',
          message: firstFailure?.status === 'unavailable' ? firstFailure.message : 'Unavailable',
        };

  const usageSection: BillingOverview['usage'] =
    usage.status === 'ok'
      ? {
          status: 'ok',
          lastSuccessfulAt: usage.lastSuccessfulAt,
          attribution: usage.attribution,
          truncated: usage.truncated,
          recordedSince: since.status === 'ok' ? since.usageEvents : null,
          link: usage.link,
        }
      : usage;

  const activity: BillingOverview['activity'] =
    paymentRecords && ledger.status === 'ok' && usage.status === 'ok'
      ? {
          status: 'ok',
          ...withSourceTruncation(
            buildActivity(paymentRecords, ledger.issuances, usage.consumption),
            ledger.truncated || (events.status === 'ok' && events.truncated)
          ),
        }
      : {
          status: 'unavailable',
          message:
            'The activity list needs payments, the credit ledger and usage, and one of them could not be loaded.',
        };

  return {
    owner: { type: owner.type, id: owner.id, name: owner.name, internal: owner.internal },
    window: { range: query.range, from: from.toISOString(), to: to.toISOString() },
    generatedAt: now.toISOString(),
    subscription,
    credits,
    payments,
    usage: usageSection,
    activity,
  };
}
