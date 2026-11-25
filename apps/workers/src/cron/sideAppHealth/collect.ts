import type { PipelineStage } from 'mongoose';
import { AgentExecutionModel, ApiKeyUsageLog, Quest, SideAppRefusal } from '@bike4mind/database';
import { DAY_MS, GAP_LOOKBACK_DAYS, HOUR_MS } from '@bike4mind/server-utils/sideApps/health/rules';
import type { HealthRow } from '@bike4mind/server-utils/sideApps/health/rows';
import type { StatusClass } from '@bike4mind/server-utils/sideApps/outcomes';

export const MAX_TIME_MS = 20_000;

interface Counted<Id> {
  _id: Id;
  count: number;
}

// Mirrors statusClassOf in server-utils/sideApps/outcomes, evaluated inside the pipeline.
const statusClassExpression = {
  $switch: {
    branches: [
      { case: { $eq: ['$statusCode', 202] }, then: 'accepted' },
      { case: { $and: [{ $gte: ['$statusCode', 200] }, { $lt: ['$statusCode', 300] }] }, then: '2xx' },
      { case: { $and: [{ $gte: ['$statusCode', 500] }, { $lt: ['$statusCode', 600] }] }, then: '5xx' },
    ],
    default: 'other',
  },
};

const hourExpression = (field: string) => ({ $subtract: [field, { $mod: [{ $toLong: field }, HOUR_MS] }] });

/** Group stage keys: the client, the optional clock hour, and the fields the classifiers read. */
const groupId = (field: string, bucketed: boolean, keys: Record<string, unknown>) => ({
  clientId: '$oauthClientId',
  ...(bucketed ? { hour: hourExpression(field) } : {}),
  ...keys,
});

const hourOf = (hour: Date | undefined) => (hour ? hour.getTime() : 0);

/**
 * Grouped per-client rows from the four sources for [from, to). Each source is matched on its
 * partial `oauthClientId` index plus time, and refusals on `clientId` plus time. A failed query
 * throws, so the run lands in the dead-letter queue instead of reporting a quiet app.
 */
export async function collectHealthRows(from: Date, to: Date, bucketed: boolean): Promise<HealthRow[]> {
  const range = (field: string) => ({ [field]: { $gte: from, $lt: to } });
  const stage = (match: Record<string, unknown>, id: Record<string, unknown>): PipelineStage[] => [
    { $match: match },
    { $group: { _id: id, count: { $sum: 1 } } },
  ];

  const [usage, quests, agents, refusals] = await Promise.all([
    ApiKeyUsageLog.aggregate<
      Counted<{
        clientId: string;
        hour?: Date;
        endpoint: string;
        completionOutcome?: string;
        completionFailureCode?: string;
        statusClass: StatusClass;
      }>
    >(
      stage(
        { oauthClientId: { $exists: true }, ...range('timestamp') },
        groupId('$timestamp', bucketed, {
          endpoint: '$endpoint',
          completionOutcome: '$completionObservation.outcome',
          completionFailureCode: '$completionObservation.failureCode',
          statusClass: statusClassExpression,
        })
      )
    ).option({ maxTimeMS: MAX_TIME_MS }),
    Quest.aggregate<
      Counted<{
        clientId: string;
        hour?: Date;
        status?: string;
        type?: string;
        errorCode?: string;
        finishReason?: string;
      }>
    >(
      stage(
        { oauthClientId: { $exists: true }, ...range('timestamp') },
        groupId('$timestamp', bucketed, {
          status: '$status',
          type: '$type',
          errorCode: '$errorCode',
          finishReason: '$promptMeta.finishReason',
        })
      )
    ).option({ maxTimeMS: MAX_TIME_MS }),
    AgentExecutionModel.aggregate<Counted<{ clientId: string; hour?: Date; status?: string }>>(
      stage(
        { oauthClientId: { $exists: true }, ...range('createdAt') },
        groupId('$createdAt', bucketed, { status: '$status' })
      )
    ).option({ maxTimeMS: MAX_TIME_MS }),
    SideAppRefusal.aggregate<Counted<{ clientId: string; hour?: Date; reason: string }>>([
      { $match: { clientId: { $exists: true }, ...range('createdAt') } },
      {
        $group: {
          _id: {
            clientId: '$clientId',
            ...(bucketed ? { hour: hourExpression('$createdAt') } : {}),
            reason: '$reason',
          },
          count: { $sum: 1 },
        },
      },
    ]).option({ maxTimeMS: MAX_TIME_MS }),
  ]);

  return [
    ...usage.map(({ _id, count }): HealthRow => ({ source: 'usage', ..._id, hourStart: hourOf(_id.hour), count })),
    ...quests.map(({ _id, count }): HealthRow => ({ source: 'quest', ..._id, hourStart: hourOf(_id.hour), count })),
    ...agents.map(({ _id, count }): HealthRow => ({ source: 'agent', ..._id, hourStart: hourOf(_id.hour), count })),
    ...refusals.map(({ _id, count }): HealthRow => ({ source: 'refusal', ..._id, hourStart: hourOf(_id.hour), count })),
  ];
}

/** Hourly rows for the trailing GAP_LOOKBACK_DAYS and exact counts for the trailing 60 minutes. */
export async function collectClientHealthRows(now: Date) {
  const [hourly, lastHour] = await Promise.all([
    collectHealthRows(new Date(now.getTime() - GAP_LOOKBACK_DAYS * DAY_MS), new Date(now.getTime() + 1), true),
    collectHealthRows(new Date(now.getTime() - HOUR_MS), new Date(now.getTime() + 1), false),
  ]);
  return { hourly, lastHour };
}
