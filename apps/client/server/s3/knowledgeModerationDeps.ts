import { FabFile, imageModerationIncidentRepository } from '@bike4mind/database';
import { moderateImageOrThrow } from '@bike4mind/services/llm';
import { RekognitionImageModerationService } from '@bike4mind/utils/imageModeration';
import type { Logger } from '@bike4mind/observability';
import { getFilesStorage } from '@server/utils/storage';
import { moderateUploadedFile } from '@server/s3/moderateUploadedFile';
import type { ModerateImportedKnowledgeFilesArgs } from '@server/s3/moderateImportedKnowledgeFiles';
import type { Types } from 'mongoose';

/**
 * The production claim/scan/persist wiring for imported-knowledge moderation, shared by the two
 * callers that run it: the notebook-import handler (scans a fresh import's files post-commit) and
 * the daily rescue sweep (re-scans files an earlier attempt left stranded on 'pending'). Both must
 * claim/persist/release identically - the claim is the single mutual-exclusion point between them -
 * so the wiring lives here once. The claim is an atomic pending|null -> scanning CAS, so only one
 * runner can ever flip a given row out of 'pending' - the two callers here (and any concurrent
 * upload-path scan) cannot double-process it. objectCreated.ts guards the upload-time scan
 * differently (it never writes the interim 'scanning' state), so this is a parallel guarantee, not
 * the identical mechanism.
 */
export function buildKnowledgeModerationDeps(
  logger: Logger
): Omit<ModerateImportedKnowledgeFilesArgs, 'filePaths' | 'userId' | 'enabled'> {
  const storage = getFilesStorage();
  return {
    service: new RekognitionImageModerationService(logger),
    incidents: imageModerationIncidentRepository,
    moderateImageOrThrow,
    moderate: moderateUploadedFile,
    logger,
    claim: async filePath => {
      const claimedAt = new Date();
      const claimed = await FabFile.findOneAndUpdate(
        { filePath, moderationStatus: { $in: ['pending', null] } },
        { $set: { moderationStatus: 'scanning', moderationClaimedAt: claimedAt } },
        { new: true }
      );
      return claimed
        ? { _id: claimed._id, id: claimed.id, mimeType: claimed.mimeType, moderationClaimedAt: claimedAt }
        : null;
    },
    // Both writers below are guarded on the claim stamp, not on 'scanning' alone: the rescue sweep
    // can reclaim a stale 'scanning' row mid-scan and a successor can re-claim it, and an
    // unguarded write here would then land on a claim this run no longer owns - clobbering a
    // successor's terminal verdict, or clearing its claim and re-opening the row to a third runner.
    // Same identity-guard shape as the chunk claim's release in queueHandlers/fabFileChunk.ts.
    persist: async (_id, patch, claimedAt) => {
      const res = await FabFile.updateOne(
        { _id: _id as Types.ObjectId, moderationStatus: 'scanning', moderationClaimedAt: claimedAt },
        { $set: patch, $unset: { moderationClaimedAt: 1 } }
      );
      return res.matchedCount > 0;
    },
    release: async (_id, claimedAt) => {
      const res = await FabFile.updateOne(
        { _id: _id as Types.ObjectId, moderationStatus: 'scanning', moderationClaimedAt: claimedAt },
        {
          // The attempt bookkeeping the rescue sweep's fairness sort and backoff read - see
          // moderationRescueSweep.ts. Written here because this is the single point every
          // transient failure on THIS door (the import path and the sweep's re-scan) funnels
          // through. objectCreated.ts has no equivalent release - a crashed upload-time scan is
          // only ever recovered by the sweep's own stale-claim reclaim, so its attempt count is
          // undercounted relative to a row scanned through here.
          $set: { moderationStatus: 'pending', moderationLastAttemptAt: new Date() },
          $inc: { moderationAttempts: 1 },
          $unset: { moderationClaimedAt: 1 },
        }
      );
      return res.matchedCount > 0;
    },
    // A missing-object orphan (see moderateImportedKnowledgeFiles.terminalOnMissingObject): the row's
    // bytes never landed, so soft-delete it rather than write a content-policy verdict. deleteOne is
    // the softDeletePlugin's soft-delete (stamps deletedAt), so the row then drops out of every
    // default find - serving and this sweep's own re-selection alike. Guarded on the claim stamp like
    // persist/release above: a successor can reclaim and cleanly scan this row between this run's
    // download failing and this delete landing, and an unguarded delete would destroy that
    // successor's clean file rather than merely dropping a verdict.
    retireMissingObject: async (_id, claimedAt) => {
      const res = await FabFile.deleteOne({
        _id: _id as Types.ObjectId,
        moderationStatus: 'scanning',
        moderationClaimedAt: claimedAt,
      });
      return res.deletedCount > 0;
    },
    downloadBytes: filePath => storage.download(filePath),
    downloadPartialBytes: (filePath, length) => storage.downloadRange(filePath, length),
  };
}
