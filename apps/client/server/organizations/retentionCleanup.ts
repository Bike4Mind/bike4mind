import {
  chargedBytes,
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
  RETENTION_QUERY_MS,
  retentionChatPipeline,
  retentionFileFilter,
} from '@bike4mind/server-utils/organizations/retentionPolicy';
import { findLiveRetainedKeys, isGeneratedContentKey } from '@server/sessions/purgeDeletedNotebookMedia';

const notHeld = { legalHold: { $ne: true } };
const actorUserId = 'system:organization-retention';

async function retainedMedia(key: string): Promise<boolean> {
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
  return !!(await Quest.findOne({ legalHold: true, $or: [{ images: key }, { videos: key }] })
    .setOptions({ includeDeleted: true })
    .select('_id')
    .maxTimeMS(RETENTION_QUERY_MS));
}

class RetentionPolicyChangedError extends Error {}

// One bad item must not stall the rest of the sweep; a changed policy must stop it.
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
  organizationId: string,
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
  const org = await Organization.findById(organizationId);
  const stored = org?.retentionPolicy;
  const parsed = retentionPolicySchema.safeParse(
    stored ? { chats: stored.chats, files: stored.files, media: stored.media } : foreverRetention
  );
  const counts = { chats: 0, files: 0, media: 0 };
  if (!org || org.personal || !parsed.success || !org.retentionVersion) return counts;
  const policy = parsed.data;
  const version = org.retentionVersion;
  let remaining = RETENTION_BATCH_SIZE;

  for (const kind of ['files', 'media'] as const) {
    const cutoff = retentionCutoff(policy[kind], now);
    if (!cutoff || remaining <= 0 || Date.now() >= deadline) continue;
    const filter = {
      ...retentionFileFilter(organizationId, cutoff, kind === 'media'),
      'sourceMetadata.retentionLastCheckedAt': { $not: { $gte: new Date(now.getTime() - 3_600_000) } },
    };
    const files = await FabFile.find(filter)
      .sort({ 'sourceMetadata.retentionLastCheckedAt': 1, createdAt: 1, _id: 1 })
      .limit(remaining)
      .maxTimeMS(RETENTION_QUERY_MS);
    for (const candidate of files) {
      if (Date.now() >= deadline || remaining-- <= 0) break;
      if (isModerationEvidenceHold(candidate)) continue;
      let result: Awaited<ReturnType<typeof fabFilesService.deleteFabFile>> | null = null;
      try {
        result = await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const file = await FabFile.findOne({ ...filter, _id: candidate._id });
          if (!file || isModerationEvidenceHold(file)) return null;
          await unpublishUserArtifactsBySource(file.userId, { kind: 'fabfile', fabFileIds: [file.id] }, { logger });
          const deleted = await fabFilesService.deleteFabFile(
            file.userId,
            { id: file.id },
            {
              db: {
                fabFiles: fabFileRepository,
                users: userRepository,
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
            }
          );
          if (deleted.action !== 'deleted') throw new Error('Retention file delete did not complete');
          if (file.organizationId)
            await organizationRepository.incrementCurrentStorage(file.organizationId, -chargedBytes(file));
          else await userRepository.incrementCurrentStorage(file.userId, -chargedBytes(file));
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
    const messages = await Session.aggregate<{ _id: string; sessionId: string }>([
      ...retentionChatPipeline(organizationId, chatCutoff, remaining),
      { $limit: remaining },
    ]).option({ maxTimeMS: RETENTION_QUERY_MS });
    for (const message of messages) {
      if (Date.now() >= deadline || remaining-- <= 0) break;
      let deleted = false;
      try {
        deleted = await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const session = await Session.findOne({
            _id: message.sessionId,
            retentionOrganizationId: organizationId,
            deletedAt: null,
            ...notHeld,
          });
          const quest = session
            ? await Quest.findOne({
                _id: message._id,
                sessionId: session.id,
                timestamp: { $lt: chatCutoff },
                deletedAt: null,
                ...notHeld,
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

  const mediaCutoff = retentionCutoff(policy.media, now);
  if (mediaCutoff && remaining > 0 && Date.now() < deadline) {
    const objects = await OrganizationGeneratedObject.find({
      organizationId,
      deletedAt: null,
      createdAt: { $lt: mediaCutoff },
      ...notHeld,
    })
      .sort({ lastCheckedAt: 1, _id: 1 })
      .limit(remaining)
      .maxTimeMS(RETENTION_QUERY_MS);
    for (const object of objects) {
      if (Date.now() >= deadline || remaining-- <= 0) break;
      const markChecked = () =>
        OrganizationGeneratedObject.updateOne({ _id: object._id, organizationId }, { $set: { lastCheckedAt: now } });
      if (!isGeneratedContentKey(object.key)) {
        await markChecked();
        continue;
      }
      let eligible = false;
      try {
        eligible = await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const session = await Session.findOne({
            _id: object.sessionId,
            userId: object.userId,
            retentionOrganizationId: organizationId,
            ...notHeld,
          }).setOptions({ includeDeleted: true });
          if (!session) return false;
          // Only this org's original notebook loses references. Copies in personal/foreign notebooks retain their media.
          const references = await Quest.find({
            sessionId: session.id,
            ...notHeld,
            $or: [{ images: object.key }, { videos: object.key }],
          })
            .select('_id')
            .limit(RETENTION_BATCH_SIZE)
            .maxTimeMS(RETENTION_QUERY_MS);
          const detached = await Quest.updateMany(
            { _id: { $in: references.map(row => row._id) }, sessionId: session.id, ...notHeld },
            { $pull: { images: object.key, videos: object.key } }
          );
          if (detached.modifiedCount)
            await OrganizationAuditEventModel.create({
              organizationId,
              actorUserId,
              action: 'retention.media_detached',
              targetId: object.key,
            });
          await OrganizationGeneratedObject.updateOne(
            { _id: object._id, organizationId },
            { $set: { lastCheckedAt: now } }
          );
          return true;
        });
      } catch (error) {
        await skipFailedItem(error, logger, 'media', object.key);
        continue;
      }
      if (!eligible) {
        await markChecked();
        continue;
      }
      if (await retainedMedia(object.key)) continue;
      try {
        await withTransaction(async () => {
          await lockPolicy(organizationId, version);
          const stillOwned = await OrganizationGeneratedObject.findOne({
            _id: object._id,
            organizationId,
            deletedAt: null,
            ...notHeld,
          });
          if (!stillOwned || (await retainedMedia(object.key))) return;
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
      }
    }
  }
  return counts;
}
