import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { adminSettingsRepository, connectDB, signupGrantBudgetRepository, User, UserApiKey } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { Config } from '@bike4mind/server-utils/utils/config';
import type { PipelineStage } from 'mongoose';
import type { ScheduledEvent } from 'aws-lambda';
import { Resource } from 'sst';

const HOUR_MS = 60 * 60 * 1000;
const GRANT_POOLS = ['signup', 'trickle'] as const;

export type GrantPoolUsage = { pool: (typeof GRANT_POOLS)[number]; spent: number; budget: number; missing: boolean };

export function accountCreationWindow(time: string) {
  const scheduled = Date.parse(time);
  if (!Number.isFinite(scheduled)) throw new Error('A valid scheduled event time is required');
  const until = new Date(Math.floor(scheduled / HOUR_MS) * HOUR_MS);
  return { since: new Date(until.getTime() - HOUR_MS), until };
}

export function accountCreationQueries(since: Date, until: Date) {
  // Test personas are synthetic but anyone holding the mint key can create them, so they still count.
  const externalAccount = { $or: [{ isSynthetic: { $ne: true } }, { isPersona: true }], isSystem: { $ne: true } };
  return {
    signups: { ...externalAccount, createdAt: { $gte: since, $lt: until } },
    // Point-in-time snapshot of accounts in debt, not a window count. Banned and suspended accounts stay counted.
    negativeBalances: { ...externalAccount, deletedAt: { $exists: false }, currentCredits: { $lt: 0 } },
    keys: [
      { $match: { createdAt: { $gte: since, $lt: until } } },
      { $addFields: { ownerId: { $convert: { input: '$userId', to: 'objectId', onError: null, onNull: null } } } },
      {
        $lookup: {
          from: User.collection.name,
          localField: 'ownerId',
          foreignField: '_id',
          as: 'owner',
        },
      },
      { $unwind: '$owner' },
      {
        $match: {
          $or: [{ 'owner.isSynthetic': { $ne: true } }, { 'owner.isPersona': true }],
          'owner.isSystem': { $ne: true },
          'owner.createdAt': { $type: 'date' },
          $expr: {
            $and: [
              { $gte: ['$createdAt', '$owner.createdAt'] },
              { $lt: [{ $subtract: ['$createdAt', '$owner.createdAt'] }, 24 * HOUR_MS] },
            ],
          },
        },
      },
      { $count: 'count' },
    ] satisfies PipelineStage[],
  };
}

export function accountCreationMetricData(
  time: string,
  signups: number,
  keys: number,
  negativeBalances: number,
  grantPools: GrantPoolUsage[] = []
) {
  const { since, until } = accountCreationWindow(time);
  const poolMetrics = grantPools.flatMap(({ pool, spent, budget, missing }) => [
    // Snapshots like NegativeBalances, so stamped with the hour boundary.
    { MetricName: 'SignupGrantPoolSpent', Value: spent, Timestamp: until, Dimensions: [{ Name: 'Pool', Value: pool }] },
    {
      MetricName: 'SignupGrantPoolBudget',
      Value: budget,
      Timestamp: until,
      Dimensions: [{ Name: 'Pool', Value: pool }],
    },
    {
      MetricName: 'SignupGrantPoolBudgetMissing',
      Value: missing ? 1 : 0,
      Timestamp: until,
      Dimensions: [{ Name: 'Pool', Value: pool }],
    },
  ]);
  return [
    { MetricName: 'SuccessfulSignups', Value: signups, Timestamp: since },
    { MetricName: 'NewAccountApiKeys', Value: keys, Timestamp: since },
    // Stamped with the hour boundary because it is read at ~:05, not accumulated over the window.
    { MetricName: 'NegativeBalances', Value: negativeBalances, Timestamp: until },
    ...poolMetrics,
    { MetricName: 'CensusCompleted', Value: 1, Timestamp: since },
  ].map(metric => ({ ...metric, Unit: 'Count' as const }));
}

async function grantPoolUsage(since: Date): Promise<GrantPoolUsage[]> {
  // The pool-day of the window start: the 00:05 run reads the day that just closed, so its last hour is published
  // and a redelivered event reads the same counter.
  const day = userService.signupGrantBudgetDay(since);
  return Promise.all(
    GRANT_POOLS.map(async pool => {
      // A missing budget row resolves to 0 and is flagged, never failing the census.
      const { budget, missing } = await userService.resolvePoolBudget(adminSettingsRepository, pool);
      const spent = await signupGrantBudgetRepository.getSpent(userService.signupGrantBudgetKey(pool, day));
      return { pool, spent, budget, missing };
    })
  );
}

export async function handler(event: ScheduledEvent): Promise<void> {
  const { since, until } = accountCreationWindow(event.time);
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });
  const queries = accountCreationQueries(since, until);
  const [signups, keys, negativeBalances, grantPools] = await Promise.all([
    User.countDocuments(queries.signups).maxTimeMS(60_000),
    UserApiKey.aggregate<{ count: number }>(queries.keys).option({ maxTimeMS: 60_000 }),
    User.countDocuments(queries.negativeBalances).maxTimeMS(60_000),
    grantPoolUsage(since),
  ]);
  // Maximum, not Sum, makes a redelivered scheduled window idempotent at the alarm boundary.
  await new CloudWatchClient({}).send(
    new PutMetricDataCommand({
      Namespace: `${Resource.App.name}/${Resource.App.stage}/AccountCreation`,
      MetricData: accountCreationMetricData(event.time, signups, keys[0]?.count ?? 0, negativeBalances, grantPools),
    })
  );
}
