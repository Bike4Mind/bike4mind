import { randomUUID } from 'node:crypto';
import {
  FabFileSourceType,
  foreverRetention,
  retentionCutoff,
  retentionKinds,
  shortensRetention,
  type OrganizationRetentionPolicy,
} from '@bike4mind/common';
import {
  FabFile,
  Organization,
  OrganizationAuditEventModel,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
  Quest,
  Session,
  withTransaction,
} from '@bike4mind/database';
import { ConflictError, BadRequestError } from '../utils/errors';

export const RETENTION_BATCH_SIZE = 50;
export const RETENTION_QUERY_MS = 5000;
const notHeld = { legalHold: { $ne: true } };

export function retentionFileFilter(organizationId: string, cutoff: Date, generated: boolean) {
  return {
    ...(generated ? { 'sourceMetadata.retentionOrganizationId': organizationId } : { organizationId }),
    deletedAt: null,
    createdAt: { $lt: cutoff },
    $or: [{ moderationStatus: { $ne: 'blocked' } }, { blockReason: 'unsupported_format' }],
    ...notHeld,
    sourceType: generated ? FabFileSourceType.TOOL_GENERATED : { $ne: FabFileSourceType.TOOL_GENERATED },
  };
}

export function retentionChatPipeline(organizationId: string, cutoff: Date, limit?: number, countOnly = false) {
  return [
    { $match: { retentionOrganizationId: organizationId, deletedAt: null, ...notHeld } },
    {
      $lookup: {
        from: Quest.collection.name,
        let: { sessionId: { $toString: '$_id' } },
        pipeline: [
          {
            $match: {
              $expr: { $eq: ['$sessionId', '$$sessionId'] },
              timestamp: { $lt: cutoff },
              deletedAt: null,
              ...notHeld,
            },
          },
          ...(limit ? [{ $limit: limit }] : []),
          ...(countOnly ? [{ $count: 'count' }] : [{ $project: { _id: 1, sessionId: 1, timestamp: 1 } }]),
        ],
        as: 'messages',
      },
    },
    { $unwind: '$messages' },
    { $replaceRoot: { newRoot: '$messages' } },
  ];
}

export async function estimateRetention(organizationId: string, policy: OrganizationRetentionPolicy, now: Date) {
  const counts = { chats: 0, files: 0, media: 0 };
  for (const kind of retentionKinds) {
    const cutoff = retentionCutoff(policy[kind], now);
    if (!cutoff) continue;
    if (kind === 'chats') {
      const result = await Session.aggregate<{ count: number }>([
        ...retentionChatPipeline(organizationId, cutoff, undefined, true),
        { $group: { _id: null, count: { $sum: '$count' } } },
      ]).option({ maxTimeMS: RETENTION_QUERY_MS });
      counts.chats = result[0]?.count ?? 0;
    } else {
      counts[kind] = await FabFile.countDocuments(
        retentionFileFilter(organizationId, cutoff, kind === 'media')
      ).maxTimeMS(RETENTION_QUERY_MS);
      if (kind === 'media') {
        counts.media += await OrganizationGeneratedObject.countDocuments({
          organizationId,
          deletedAt: null,
          createdAt: { $lt: cutoff },
          ...notHeld,
        }).maxTimeMS(RETENTION_QUERY_MS);
      }
    }
  }
  return counts;
}

export async function createRetentionEstimate(
  organizationId: string,
  actorUserId: string,
  version: number,
  policy: OrganizationRetentionPolicy,
  now = new Date()
) {
  const counts = await estimateRetention(organizationId, policy, now);
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + 600_000);
  await OrganizationRetentionEstimate.create({
    token,
    organizationId,
    actorUserId,
    version,
    policy,
    counts,
    estimatedAt: now,
    expiresAt,
  });
  return { token, counts, estimatedAt: now, expiresAt };
}

export async function saveRetentionPolicy(
  organizationId: string,
  actorUserId: string,
  policy: OrganizationRetentionPolicy,
  version: number,
  token?: string,
  now = new Date()
) {
  return withTransaction(async () => {
    const org = await Organization.findById(organizationId);
    if (!org || (org.retentionVersion ?? 0) !== version)
      throw new ConflictError('Policy changed; reload and estimate again');
    if (org.personal) throw new BadRequestError('Retention requires a team organization');
    const before = org.retentionPolicy ?? foreverRetention;
    if (shortensRetention(before, policy)) {
      const estimate = token
        ? await OrganizationRetentionEstimate.findOne({
            token,
            organizationId,
            actorUserId,
            version,
            expiresAt: { $gt: now },
          })
        : null;
      if (!estimate || retentionKinds.some(kind => estimate.policy[kind] !== policy[kind])) {
        throw new BadRequestError('A fresh deletion estimate and explicit confirmation are required');
      }
      await OrganizationRetentionEstimate.deleteOne({ _id: estimate._id });
    }
    const changed = await Organization.updateOne(
      {
        _id: org._id,
        $or: [{ retentionVersion: version }, ...(version === 0 ? [{ retentionVersion: { $exists: false } }] : [])],
      },
      { $set: { retentionPolicy: policy }, $inc: { retentionVersion: 1 } }
    );
    if (changed.modifiedCount !== 1) throw new ConflictError('Policy changed; reload and estimate again');
    await OrganizationAuditEventModel.create({
      organizationId,
      actorUserId,
      action: 'policy.updated',
      targetId: `retention:${version + 1}`,
    });
    return { policy, version: version + 1 };
  });
}
