import {
  chargedBytes,
  storageOwnerOf,
  foreverRetention,
  isModerationEvidenceHold,
  retentionCutoff,
  retentionPolicySchema,
  type RetentionKind,
} from '@bike4mind/common';
import {
  FabFile,
  Organization,
  OrganizationAuditEventModel,
  OrganizationGeneratedObject,
  Quest,
  Session,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  organizationRepository,
  projectRepository,
  questRepository,
  sessionRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { fabFilesService, sessionService } from '@bike4mind/services';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { Logger } from '@bike4mind/observability';
import { lakeMembershipAuditDb } from '@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { createCdnInvalidationBatch, generatedCdnPath } from '@bike4mind/server-utils/services/cdn/invalidateRouterCdn';
import { unpublishUserArtifactsBySource } from '@bike4mind/server-utils/services/publish/purgeUserPublishedArtifacts';
import {
  RETENTION_BATCH_SIZE,
  retentionNotHeldFilter,
  RETENTION_QUERY_MS,
  retentionSessionIdPages,
  retentionChatFilter,
  retentionFileFilter,
} from '@bike4mind/server-utils/organizations/retentionPolicy';
import { findLiveRetainedKeys, isGeneratedContentKey } from '@server/sessions/purgeDeletedNotebookMedia';

const actorUserId = 'system:organization-retention';

async function retainedMedia(key: string, originSessionId: string): Promise<boolean> {
  if (
    await Session.exists({ _id: originSessionId, legalHold: true })
      .setOptions({ includeDeleted: true })
      .maxTimeMS(RETENTION_QUERY_MS)
  )
    return true;
  if ((await findLiveRetainedKeys([key])).has(key)) return true;
  const heldOrLiveFile = await FabFile.findOne({
    $and: [
      { $or: [{ 'sourceMetadata.generatedCopyKey': key }, { 'sourceMetadata.generatedOutputKey': key }] },
      {
        $or: [
          { deletedAt: null },
          { legalHold: true },
          { moderationStatus: 'blocked', blockReason: { $ne: 'unsupported_format' } },
        ],
      },
    ],
  })
    .setOptions({ includeDeleted: true })
    .select('_id')
    .maxTimeMS(RETENTION_QUERY_MS);
  if (heldOrLiveFile) return true;
  if (
    await Quest.findOne({ legalHold: true, $or: [{ images: key }, { videos: key }] })
      .setOptions({ includeDeleted: true })
      .select('_id')
      .maxTimeMS(RETENTION_QUERY_MS)
  )
    return true;
  return hasHeldMediaNotebook(key);
}

async function hasHeldMediaNotebook(key: string): Promise<boolean> {
  const deadline = Date.now() + RETENTION_QUERY_MS;
  let afterId: string | undefined;
  while (Date.now() < deadline) {
    const references = await Quest.find({
      $or: [{ images: key }, { videos: key }],
      ...(afterId ? { _id: { $gt: afterId } } : {}),
    })
      .setOptions({ includeDeleted: true })
      .select('_id sessionId')
      .sort({ _id: 1 })
      .limit(RETENTION_BATCH_SIZE)
      .maxTimeMS(Math.max(1, deadline - Date.now()))
      .lean();
    if (!references.length) return false;
    const sessionIds = references
      .map(row => row.sessionId)
      .filter((id: unknown): id is string => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id));
    if (
      sessionIds.length > 0 &&
      (await Session.exists({ _id: { $in: sessionIds }, legalHold: true })
        .setOptions({ includeDeleted: true })
        .maxTimeMS(Math.max(1, deadline - Date.now())))
    )
      return true;
    if (references.length < RETENTION_BATCH_SIZE) return false;
    afterId = String(references[references.length - 1]._id);
  }
  throw new Error('Retention media reference scan timed out; object retained');
}

class RetentionPolicyChangedError extends Error {}

async function skipFailedItem(error: unknown, logger: Logger, kind: RetentionKind, id: string) {
  if (error instanceof RetentionPolicyChangedError) throw error;
  logger.warn('Retention delete failed; continuing with the next item', { kind, id, error });
}

async function lockPolicy(organizationId: string, version: number) {
  const result = await Organization.updateOne(
    { _id: organizationId, deletedAt: null, personal: false, retentionVersion: version },
    { $inc: { retentionSweepRevision: 1 } }
  );
  if (result.modifiedCount !== 1) throw new RetentionPolicyChangedError('Retention policy changed; sweep stopped');
}

async function audit(organizationId: string, kind: RetentionKind, id: string, version: number) {
  await OrganizationAuditEventModel.create({
    organizationId,
    actorUserId,
    action: 'retention.deleted',
    targetId: `${kind}:${id}:policy:${version}`,
  });
}

export async function cleanupOrganizationRetention(
  requestedOrganizationId: string,
  {
    now = new Date(),
    deadline = Date.now() + 120_000,
    logger = Logger.globalInstance,
  }: {
    now?: Date;
    deadline?: number;
    logger?: Logger;
  } = {}
) {
  const org = await Organization.findById(requestedOrganizationId);
  const stored = org?.retentionPolicy;
  const parsed = retentionPolicySchema.safeParse(
    stored ? { chats: stored.chats, files: stored.files, media: stored.media } : foreverRetention
  );
  const counts = { chats: 0, files: 0, media: 0 };
  if (!org || org.personal || !parsed.success || !org.retentionVersion) return counts;
  const organizationId = org.id;
  const policy = parsed.data;
  const version = org.retentionVersion;
  let remaining = RETENTION_BATCH_SIZE;
  const enabledPhases =
    Number(policy.files !== null) + Number(policy.chats !== null) + 2 * Number(policy.media !== null);
  // Reserve work for every enabled phase even when another phase repeatedly fails.
  const phaseLimit = Math.max(1, Math.floor(RETENTION_BATCH_SIZE / Math.max(1, enabledPhases)));

  for (const kind of ['files', 'media'] as const) {
    const cutoff = retentionCutoff(policy[kind], now);
    if (!cutoff || remaining <= 0 || Date.now() >= deadline) continue;
    const filter = {
      ...retentionFileFilter(organizationId, cutoff, kind === 'media'),
      'sourceMetadata.retentionLastCheckedAt': { $not: { $gte: new Date(now.getTime() - 3_600_000) } },
    };
    const files = await FabFile.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .limit(Math.min(remaining, phaseLimit))
      .maxTimeMS(RETENTION_QUERY_MS);
    for (const candidate of files) {
      if (Date.now() >= deadline || remaining-- <= 0) break;
      if (isModerationEvidenceHold(candidate)) continue;
      let result: Awaited<ReturnType<typeof fabFilesService.deleteAuthorizedFabFile>> | null = null;
      try {
        result = await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const file = await FabFile.findOne({ ...filter, _id: candidate._id });
          if (!file || isModerationEvidenceHold(file)) return null;
          await unpublishUserArtifactsBySource(file.userId, { kind: 'fabfile', fabFileIds: [file.id] }, { logger });
          const deleted = await fabFilesService.deleteAuthorizedFabFile(file, {
            db: {
              fabFiles: fabFileRepository,
              sessions: sessionRepository,
              fabFileChunks: fabFileChunkRepository,
              dataLakes: dataLakeRepository,
              ...lakeMembershipAuditDb,
            },
            storage: getFilesStorage(),
            // Inline media has its own policy and explicit object ledger; file deletion must not remove it early.
            generatedCopies: { storage: { delete: async () => undefined }, quests: questRepository },
            searchIndex: selfHostOpenSearchEnabled() ? FabFileChunkSearchIndex : undefined,
            logger,
          });
          if (deleted.action !== 'deleted') throw new Error('Retention file delete did not complete');
          await fabFilesService.adjustOwnerStorage(
            { users: userRepository, organizations: organizationRepository },
            storageOwnerOf(file),
            -chargedBytes(file)
          );
          await audit(organizationId, kind, file.id, version);
          return deleted;
        });
      } catch (error) {
        await skipFailedItem(error, logger, kind, candidate.id);
        await FabFile.collection.updateOne(
          { _id: candidate._id },
          { $set: { 'sourceMetadata.retentionLastCheckedAt': now } }
        );
        continue;
      }
      if (result?.references) {
        await fabFilesService.cleanUpDeletedFileReferences(
          result.references,
          { users: userRepository, projects: projectRepository },
          logger
        );
        counts[kind]++;
      }
    }
  }

  const chatCutoff = retentionCutoff(policy.chats, now);
  if (chatCutoff && remaining > 0 && Date.now() < deadline) {
    let chatAttempts = 0;
    for await (const sessionIds of retentionSessionIdPages(organizationId, deadline)) {
      if (remaining <= 0 || chatAttempts >= phaseLimit || Date.now() >= deadline) break;
      const messages = await Quest.find(retentionChatFilter(sessionIds, chatCutoff))
        .select('_id sessionId')
        .sort({ timestamp: 1, _id: 1 })
        .limit(Math.min(remaining, phaseLimit - chatAttempts))
        .maxTimeMS(Math.max(1, Math.min(RETENTION_QUERY_MS, deadline - Date.now())))
        .lean();
      for (const message of messages) {
        if (Date.now() >= deadline || remaining-- <= 0) break;
        chatAttempts++;
        let deleted = false;
        try {
          deleted = await withTransaction(async () => {
            await lockPolicy(organizationId, version);
            const session = await Session.findOne({
              _id: message.sessionId,
              retentionOrganizationId: organizationId,
              deletedAt: null,
              ...retentionNotHeldFilter,
            });
            const quest = session
              ? await Quest.findOne({
                  _id: message._id,
                  sessionId: session.id,
                  timestamp: { $lt: chatCutoff },
                  deletedAt: null,
                  ...retentionNotHeldFilter,
                })
              : null;
            if (!session || !quest) return false;
            await unpublishUserArtifactsBySource(
              session.userId,
              { kind: 'replyMessage', sessionId: session.id, messageIds: [quest.id] },
              { logger }
            );
            await sessionService.deleteSessionMessage(
              session.userId,
              { sessionId: session.id, messageId: quest.id },
              {
                db: { sessions: sessionRepository, chatHistories: questRepository },
              }
            );
            await Session.updateOne(
              { _id: session._id },
              {
                $unset: {
                  summary: 1,
                  summaryAt: 1,
                  summaryModelId: 1,
                  summaryTrigger: 1,
                  contextSummary: 1,
                  contextSummaryUpToQuestId: 1,
                  contextSummaryAt: 1,
                  contextSummaryModelId: 1,
                },
              }
            );
            await audit(organizationId, 'chats', quest.id, version);
            return true;
          });
        } catch (error) {
          await skipFailedItem(error, logger, 'chats', String(message._id));
          continue;
        }
        if (deleted) counts.chats++;
      }
    }
  }

  const mediaCutoff = retentionCutoff(policy.media, now);
  if (mediaCutoff && remaining > 0 && Date.now() < deadline) {
    const objects = await OrganizationGeneratedObject.find({
      organizationId,
      deletedAt: null,
      createdAt: { $lt: mediaCutoff },
    })
      .sort({ lastCheckedAt: 1, _id: 1 })
      .limit(Math.min(remaining, phaseLimit))
      .maxTimeMS(RETENTION_QUERY_MS);
    for (const object of objects) {
      if (Date.now() >= deadline || remaining-- <= 0) break;
      const markChecked = () =>
        OrganizationGeneratedObject.updateOne({ _id: object._id, organizationId }, { $set: { lastCheckedAt: now } });
      try {
        if (!isGeneratedContentKey(object.key)) continue;
        const eligible = await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const owned = await OrganizationGeneratedObject.findOne({
            _id: object._id,
            organizationId,
            deletedAt: null,
            createdAt: { $lt: mediaCutoff },
          });
          if (!owned) return false;
          if (
            await Session.exists({ _id: owned.sessionId, legalHold: true })
              .setOptions({ includeDeleted: true })
              .maxTimeMS(RETENTION_QUERY_MS)
          )
            return false;
          const session = await Session.findOne({
            _id: owned.sessionId,
            retentionOrganizationId: organizationId,
            ...retentionNotHeldFilter,
          }).setOptions({ includeDeleted: true });
          // The immutable ledger owns the object even after its origin or creator was erased.
          // Detach only this org's original references; personal/foreign copies remain authoritative.
          if (session) {
            const references = await Quest.find({
              sessionId: session.id,
              ...retentionNotHeldFilter,
              $or: [{ images: object.key }, { videos: object.key }],
            })
              .select('_id')
              .limit(RETENTION_BATCH_SIZE)
              .maxTimeMS(RETENTION_QUERY_MS);
            const detached = await Quest.updateMany(
              { _id: { $in: references.map(row => row._id) }, sessionId: session.id, ...retentionNotHeldFilter },
              { $pull: { images: object.key, videos: object.key } }
            );
            if (detached.modifiedCount)
              await OrganizationAuditEventModel.create({
                organizationId,
                actorUserId,
                action: 'retention.media_detached',
                targetId: object.key,
              });
          }
          await OrganizationGeneratedObject.updateOne(
            { _id: object._id, organizationId },
            { $set: { lastCheckedAt: now } }
          );
          return true;
        });
        if (!eligible || (await retainedMedia(object.key, object.sessionId))) continue;
        await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const stillOwned = await OrganizationGeneratedObject.findOne({
            _id: object._id,
            organizationId,
            deletedAt: null,
            createdAt: { $lt: mediaCutoff },
          });
          if (!stillOwned || (await retainedMedia(object.key, object.sessionId))) return;
          await getGeneratedImageStorage().delete(object.key);
          const batch = createCdnInvalidationBatch('organization-retention', logger);
          batch.add(generatedCdnPath(object.key));
          await batch.flush();
          const result = await OrganizationGeneratedObject.updateOne(
            { _id: object._id, organizationId, deletedAt: null },
            { $set: { deletedAt: now } }
          );
          if (result.modifiedCount) {
            await audit(organizationId, 'media', object.key, version);
            counts.media++;
          }
        });
      } catch (error) {
        await skipFailedItem(error, logger, 'media', object.key);
      } finally {
        await markChecked();
      }
    }
  }
  return counts;
}
