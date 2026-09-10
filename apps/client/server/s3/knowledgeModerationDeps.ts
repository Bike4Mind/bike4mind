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
 * so the wiring lives here once. The atomic claim is the same pending|null -> scanning CAS
 * objectCreated.ts uses, so a concurrent upload-path scan of the same row cannot double-process it.
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
        { $set: { moderationStatus: 'scanning' } },
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
    downloadBytes: filePath => storage.download(filePath),
    downloadPartialBytes: (filePath, length) => storage.downloadRange(filePath, length),
  };
}
