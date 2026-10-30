import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { connectDB, User, UserApiKey } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import type { PipelineStage } from 'mongoose';
import type { ScheduledEvent } from 'aws-lambda';
import { Resource } from 'sst';

const HOUR_MS = 60 * 60 * 1000;

export function accountCreationWindow(time: string) {
  const scheduled = Date.parse(time);
  if (!Number.isFinite(scheduled)) throw new Error('A valid scheduled event time is required');
  const until = new Date(Math.floor(scheduled / HOUR_MS) * HOUR_MS);
  return { since: new Date(until.getTime() - HOUR_MS), until };
}

export function accountCreationQueries(since: Date, until: Date) {
  const externalAccount = { isSynthetic: { $ne: true }, isSystem: { $ne: true } };
  return {
    signups: { ...externalAccount, createdAt: { $gte: since, $lt: until } },
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
          'owner.isSynthetic': { $ne: true },
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

export function accountCreationMetricData(time: string, signups: number, keys: number) {
  const { since } = accountCreationWindow(time);
  return [
    { MetricName: 'SuccessfulSignups', Value: signups },
    { MetricName: 'NewAccountApiKeys', Value: keys },
    { MetricName: 'CensusCompleted', Value: 1 },
  ].map(metric => ({ ...metric, Unit: 'Count' as const, Timestamp: since }));
}

export async function handler(event: ScheduledEvent): Promise<void> {
  const { since, until } = accountCreationWindow(event.time);
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });
  const queries = accountCreationQueries(since, until);
  const [signups, keys] = await Promise.all([
    User.countDocuments(queries.signups).maxTimeMS(60_000),
    UserApiKey.aggregate<{ count: number }>(queries.keys).option({ maxTimeMS: 60_000 }),
  ]);
  // Maximum, not Sum, makes a redelivered scheduled window idempotent at the alarm boundary.
  await new CloudWatchClient({}).send(
    new PutMetricDataCommand({
      Namespace: `${Resource.App.name}/${Resource.App.stage}/AccountCreation`,
      MetricData: accountCreationMetricData(event.time, signups, keys[0]?.count ?? 0),
    })
  );
}
