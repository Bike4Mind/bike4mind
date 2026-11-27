import type { PipelineStage } from 'mongoose';
import {
  ApiKeyUsageLog,
  CreditTransaction,
  SideAppRefusal,
  User,
  oauthClientRepository,
  userRepository,
} from '@bike4mind/database';
import { getActiveSubscriptionsForUser } from '@bike4mind/server-utils/entitlements/activeSubscriptions';
import { holdsPaidStanding } from '@bike4mind/server-utils/entitlements/paidStanding';
import type { StatusClass } from '@bike4mind/server-utils/sideApps/outcomes';
import type {
  SideAppTierBucket,
  SideAppUserRow,
  SideAppUserTier,
  SideAppUsersResponse,
} from '../../../shared/sideApps';
import {
  MAX_TIME_MS,
  chargeMatch,
  emptyTierCredits,
  findAttributionStartedAt,
  foldRequestRow,
  resolveUnstampedExchangeKeys,
  resolveWindows,
  statusClassExpression,
  tierBucketExpression,
  unstampedKeyMatch,
} from './shared';

export const SIDE_APP_USERS_LIMIT = 200;
const TOP_MODELS = 3;
const TIER_READ_CONCURRENCY = 10;
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

interface UserAccumulator {
  credits: number;
  creditsByTier: ReturnType<typeof emptyTierCredits>;
  models: Map<string, number>;
  requests: number;
  endpoints: Map<string, number>;
  failedRequests: number;
  refusals: number;
  lastUsedMs: number;
}

const newUser = (): UserAccumulator => ({
  credits: 0,
  creditsByTier: emptyTierCredits(),
  models: new Map(),
  requests: 0,
  endpoints: new Map(),
  failedRequests: 0,
  refusals: 0,
  lastUsedMs: 0,
});

/** The member who made an org-billed charge is recorded only on some rows. */
const actorExpression = { $cond: [{ $eq: ['$ownerType', 'User'] }, '$ownerId', '$metadata.actingUserId'] };

async function readCurrentTiers(
  userIds: string[],
  users: Map<string, { lastCreditsPurchasedAt?: Date | null }>
): Promise<Map<string, SideAppUserTier>> {
  const tiers = new Map<string, SideAppUserTier>();
  for (let i = 0; i < userIds.length; i += TIER_READ_CONCURRENCY) {
    await Promise.all(
      userIds.slice(i, i + TIER_READ_CONCURRENCY).map(async id => {
        const user = users.get(id);
        if (!user) return tiers.set(id, 'unknown');
        try {
          const subscriptions = await getActiveSubscriptionsForUser(id, { strict: true });
          tiers.set(id, holdsPaidStanding(user, subscriptions) ? 'paid' : 'unpaid');
        } catch {
          tiers.set(id, 'unknown');
        }
      })
    );
  }
  return tiers;
}

export async function readSideAppUsers(
  clientId: string,
  days: number,
  now: Date = new Date()
): Promise<SideAppUsersResponse> {
  const windows = resolveWindows(days, now);
  const unstampedKeys = await resolveUnstampedExchangeKeys(windows.legacyFrom);
  const legacyKeyIds = [...unstampedKeys].filter(([, owner]) => owner === clientId).map(([keyId]) => keyId);

  const stampedMatch = { oauthClientId: clientId, ...chargeMatch(windows.spendFrom) };
  const ledgerMatch = legacyKeyIds.length
    ? {
        $or: [stampedMatch, unstampedKeyMatch(windows.legacyFrom, legacyKeyIds)],
      }
    : stampedMatch;
  const ledger = (stages: PipelineStage[]) =>
    CreditTransaction.aggregate([{ $match: ledgerMatch }, ...stages]).option({ maxTimeMS: MAX_TIME_MS });
  const [tierRows, modelRows, usageRows, refusalRows, attributionStartedAt, clients] = await Promise.all([
    ledger([
      {
        $group: {
          _id: { userId: actorExpression, bucket: tierBucketExpression },
          credits: { $sum: { $abs: '$credits' } },
          lastAt: { $max: '$createdAt' },
        },
      },
    ]) as Promise<Array<{ _id: { userId?: string | null; bucket: SideAppTierBucket }; credits: number; lastAt: Date }>>,
    ledger([
      { $match: { model: { $type: 'string' } } },
      {
        $group: {
          _id: { userId: actorExpression, model: '$model' },
          credits: { $sum: { $abs: '$credits' } },
        },
      },
    ]) as Promise<Array<{ _id: { userId?: string | null; model: string }; credits: number }>>,
    ApiKeyUsageLog.aggregate<{
      _id: { userId: string; endpoint: string; completionOutcome?: string; statusClass: StatusClass };
      count: number;
      lastAt: Date;
    }>([
      { $match: { oauthClientId: clientId, timestamp: { $gte: windows.requestFrom } } },
      {
        $group: {
          _id: {
            userId: '$userId',
            endpoint: '$endpoint',
            completionOutcome: '$completionObservation.outcome',
            statusClass: statusClassExpression,
          },
          count: { $sum: 1 },
          lastAt: { $max: '$timestamp' },
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
    SideAppRefusal.aggregate<{ _id: string; count: number }>([
      { $match: { clientId, userId: { $exists: true }, createdAt: { $gte: windows.requestFrom } } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
    findAttributionStartedAt(),
    oauthClientRepository.findByClientIds([clientId]),
  ]);

  const byUser = new Map<string, UserAccumulator>();
  const user = (id: string) => {
    let accumulator = byUser.get(id);
    if (!accumulator) byUser.set(id, (accumulator = newUser()));
    return accumulator;
  };

  let unattributedOrgCredits = 0;
  for (const row of tierRows) {
    if (!row._id.userId) {
      unattributedOrgCredits += row.credits;
      continue;
    }
    const accumulator = user(String(row._id.userId));
    accumulator.credits += row.credits;
    accumulator.creditsByTier[row._id.bucket] += row.credits;
    accumulator.lastUsedMs = Math.max(accumulator.lastUsedMs, new Date(row.lastAt).getTime());
  }
  for (const row of modelRows) {
    if (!row._id.userId) continue;
    const models = user(String(row._id.userId)).models;
    models.set(row._id.model, (models.get(row._id.model) ?? 0) + row.credits);
  }
  for (const row of usageRows) {
    const accumulator = user(row._id.userId);
    const folded = foldRequestRow({ ...row._id, count: row.count });
    accumulator.requests += row.count;
    accumulator.endpoints.set(folded.endpoint, (accumulator.endpoints.get(folded.endpoint) ?? 0) + row.count);
    if (folded.outcome === 'failed' || folded.outcome === 'interrupted') accumulator.failedRequests += row.count;
    accumulator.lastUsedMs = Math.max(accumulator.lastUsedMs, new Date(row.lastAt).getTime());
  }
  for (const row of refusalRows) user(String(row._id)).refusals += row.count;

  const ranked = [...byUser.entries()].sort(
    ([idA, a], [idB, b]) => b.credits - a.credits || b.requests - a.requests || idA.localeCompare(idB)
  );
  const page = ranked.slice(0, SIDE_APP_USERS_LIMIT);
  const pageIds = page.map(([id]) => id).filter(id => OBJECT_ID_RE.test(id));
  const [docs, purchases] = pageIds.length
    ? await Promise.all([
        userRepository.findByIds(pageIds),
        User.find({ _id: { $in: pageIds } })
          .select('lastCreditsPurchasedAt')
          .lean<Array<{ _id: unknown; lastCreditsPurchasedAt?: Date | null }>>(),
      ])
    : [[], []];
  const docById = new Map(docs.map(doc => [String(doc.id), doc]));
  const purchaseById = new Map(purchases.map(doc => [String(doc._id), doc]));
  const tiers = await readCurrentTiers(
    pageIds,
    new Map(pageIds.filter(id => docById.has(id)).map(id => [id, purchaseById.get(id) ?? {}]))
  );

  const users: SideAppUserRow[] = page.map(([userId, accumulator]) => {
    const doc = docById.get(userId);
    return {
      userId,
      name: doc ? doc.name || doc.username || null : null,
      email: doc?.email ?? null,
      currentTier: tiers.get(userId) ?? 'unknown',
      credits: accumulator.credits,
      creditsByTier: accumulator.creditsByTier,
      requests: accumulator.requests,
      requestsByEndpoint: [...accumulator.endpoints.entries()]
        .map(([endpoint, count]) => ({ endpoint, count }))
        .sort((a, b) => b.count - a.count),
      failedRequests: accumulator.failedRequests,
      refusals: accumulator.refusals,
      lastUsedAt: accumulator.lastUsedMs ? new Date(accumulator.lastUsedMs).toISOString() : null,
      topModels: [...accumulator.models.entries()]
        .map(([model, credits]) => ({ model, credits }))
        .sort((a, b) => b.credits - a.credits || a.model.localeCompare(b.model))
        .slice(0, TOP_MODELS),
    };
  });

  return {
    clientId,
    name: clients.get(clientId)?.name ?? clientId,
    days: windows.spendDays,
    spendWindowDays: windows.spendDays,
    requestWindowDays: windows.requestDays,
    attributionStartedAt,
    totalUsers: ranked.length,
    limit: SIDE_APP_USERS_LIMIT,
    users,
    unattributedOrgCredits,
  };
}
