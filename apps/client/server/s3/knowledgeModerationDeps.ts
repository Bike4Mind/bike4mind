import { FabFile, imageModerationIncidentRepository } from '@bike4mind/database';
import { moderateImageOrThrow } from '@bike4mind/services';
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
      const claimed = await FabFile.findOneAndUpdate(
        { filePath, moderationStatus: { $in: ['pending', null] } },
        { $set: { moderationStatus: 'scanning', moderationClaimedAt: new Date() } },
        { new: true }
      );
      return claimed ? { _id: claimed._id, id: claimed.id, mimeType: claimed.mimeType } : null;
    },
    persist: async (_id, patch) => {
      await FabFile.updateOne({ _id: _id as Types.ObjectId }, { $set: patch });
    },
    release: async _id => {
      await FabFile.updateOne(
        { _id: _id as Types.ObjectId, moderationStatus: 'scanning' },
        { $set: { moderationStatus: 'pending' } }
      );
    },
    // A missing-object orphan (see moderateImportedKnowledgeFiles.terminalOnMissingObject): the row's
    // bytes never landed, so soft-delete it rather than write a content-policy verdict. deleteOne is
    // the softDeletePlugin's soft-delete (stamps deletedAt), so the row then drops out of every
    // default find - serving and this sweep's own re-selection alike.
    retireMissingObject: async _id => {
      await FabFile.deleteOne({ _id: _id as Types.ObjectId });
    },
    downloadBytes: filePath => storage.download(filePath),
    downloadPartialBytes: (filePath, length) => storage.downloadRange(filePath, length),
  };
}
