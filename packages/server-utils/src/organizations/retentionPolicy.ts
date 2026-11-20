import { randomUUID } from 'node:crypto';
import {
  FabFileSourceType,
  foreverRetention,
  retentionCutoff,
  retentionKinds,
  shortensRetention,
  type OrganizationRetentionPolicy,
  type IOrganizationDocument,
} from '@bike4mind/common';
import {
  FabFile,
  Organization,
  OrganizationGeneratedObject,
  OrganizationRetentionEstimate,
  Quest,
  Session,
  withTransaction,
  lockRetentionCreator,
} from '@bike4mind/database';
import { ConflictError, BadRequestError, ServiceUnavailableError, NotFoundError } from '../utils/errors';
import { recordOrganizationAuditEvent } from '../utils/organizationAudit';

export const RETENTION_BATCH_SIZE = 50;
export const RETENTION_QUERY_MS = 5000;
export const RETENTION_SESSION_PAGE_SIZE = 100;
export const RETENTION_ESTIMATE_MS = 25_000;
export const retentionNotHeldFilter = { legalHold: { $ne: true } };

export function retentionFileFilter(organizationId: string, cutoff: Date, generated: boolean) {
  return {
    ...(generated
      ? { 'sourceMetadata.retentionOrganizationId': { $eq: organizationId, $exists: true } }
      : { organizationId: { $eq: organizationId, $exists: true } }),
    deletedAt: null,
    createdAt: { $lt: cutoff },
    $or: [{ moderationStatus: { $ne: 'blocked' } }, { blockReason: 'unsupported_format' }],
    ...retentionNotHeldFilter,
    sourceType: generated ? FabFileSourceType.TOOL_GENERATED : { $ne: FabFileSourceType.TOOL_GENERATED },
  };
}

/** Indexed session pages, bounded by the caller's overall work deadline. */
export async function* retentionSessionIdPages(organizationId: string, deadline: number) {
  let afterId: string | undefined;
  while (Date.now() < deadline) {
    const rows = await Session.find({
      retentionOrganizationId: { $eq: organizationId, $exists: true },
      deletedAt: null,
      ...retentionNotHeldFilter,
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    })
      .select('_id')
      .sort({ _id: 1 })
      .limit(RETENTION_SESSION_PAGE_SIZE)
      .maxTimeMS(Math.max(1, Math.min(RETENTION_QUERY_MS, deadline - Date.now())))
      .lean();
    if (!rows.length) return;
    const ids = rows.map(row => String(row._id));
    yield ids;
    if (rows.length < RETENTION_SESSION_PAGE_SIZE) return;
    afterId = ids[ids.length - 1];
  }
}

export const retentionChatFilter = (sessionIds: readonly string[], cutoff: Date) => ({
  sessionId: { $in: [...sessionIds] },
  timestamp: { $lt: cutoff },
  deletedAt: null,
  ...retentionNotHeldFilter,
});

export async function estimateRetention(
  organizationId: string,
  policy: OrganizationRetentionPolicy,
  now: Date,
  { deadline = Date.now() + RETENTION_ESTIMATE_MS }: { deadline?: number } = {}
) {
  const counts = { chats: 0, files: 0, media: 0 };
  const queryTime = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ServiceUnavailableError('Retention estimate timed out; please try again');
    return Math.min(RETENTION_QUERY_MS, remaining);
  };
  for (const kind of retentionKinds) {
    const cutoff = retentionCutoff(policy[kind], now);
    if (!cutoff) continue;
    queryTime();
    if (kind === 'chats') {
      for await (const sessionIds of retentionSessionIdPages(organizationId, deadline)) {
        counts.chats += await Quest.countDocuments(retentionChatFilter(sessionIds, cutoff)).maxTimeMS(queryTime());
      }
    } else {
      counts[kind] = await FabFile.countDocuments(
        retentionFileFilter(organizationId, cutoff, kind === 'media')
      ).maxTimeMS(queryTime());
      if (kind === 'media') {
        counts.media += await OrganizationGeneratedObject.countDocuments({
          organizationId,
          deletedAt: null,
          createdAt: { $lt: cutoff },
        }).maxTimeMS(queryTime());
      }
    }
  }
  // Expiration during paging must never turn a partial count into a confirmation token.
  queryTime();
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
  await withTransaction(async session => {
    if (!(await lockRetentionCreator(actorUserId, session))) {
      throw new ConflictError('The requesting account is no longer active');
    }
    await OrganizationRetentionEstimate.create(
      [
        {
          token,
          organizationId,
          actorUserId,
          version,
          policy,
          counts,
          estimatedAt: now,
          expiresAt,
        },
      ],
      { session }
    );
  });
  return { token, counts, estimatedAt: now, expiresAt };
}

export async function saveRetentionPolicy(
  organizationId: string,
  actorUserId: string,
  policy: OrganizationRetentionPolicy,
  version: number,
  token?: string,
  now = new Date(),
  {
    auditActorUserId = actorUserId,
    canAdminister,
  }: {
    auditActorUserId?: string;
    canAdminister?: (organization: IOrganizationDocument) => boolean;
  } = {}
) {
  return withTransaction(async () => {
    const org = await Organization.findById(organizationId);
    if (canAdminister && (!org || !canAdminister(org))) throw new NotFoundError('Organization not found');
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
    await recordOrganizationAuditEvent({
      organizationId: org.id,
      actorUserId: auditActorUserId,
      action: 'policy.updated',
      targetId: `retention:${version + 1}`,
    });
    return { policy, version: version + 1 };
  });
}
