import { adminSettingsRepository, FabFile, organizationRepository } from '@bike4mind/database';
import { StorageLimitError, type IUserDocument } from '@bike4mind/common';
import { checkStorageLimitForFile, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
import { MAX_FILE_SIZE_DEFAULT_MB } from '@server/utils/maxFileSizeDefault';
import type { Types } from 'mongoose';

export type LandedUploadRejection = 'larger_than_declared' | 'file_too_large' | 'storage_limit_exceeded';

/**
 * Judges an upload by the size S3 measured, before the row is marked complete: the create-time
 * size and quota checks ran on the size the uploader declared, so the object must not be larger
 * than that, must stay under MaxFileSize, and must fit the owner's (or owning org's) storage limit.
 * Only a first landing is judged; a later write to a complete row is a server-side rewrite, which
 * its own commit charges (commitContentRewrite). Shared by the hosted S3 event (objectCreated.ts)
 * and the self-host MinIO webhook (pages/api/internal/s3/object-created.ts).
 */
export const judgeLandedUpload = async (args: {
  measuredSize: number;
  declaredSize: number | null | undefined;
  statusBeforeUpload: string | null | undefined;
  owner: IUserDocument | null;
  organizationId?: string | null;
}): Promise<LandedUploadRejection | null> => {
  const { measuredSize, declaredSize, statusBeforeUpload, owner, organizationId } = args;
  if (statusBeforeUpload === 'complete') return null;

  // An unknown (0/unset) declaration is left to the size and quota checks below.
  if (declaredSize && measuredSize > declaredSize) return 'larger_than_declared';

  const maxBytes =
    getSettingsValue(
      'MaxFileSize',
      await getSettingsMap({ adminSettings: adminSettingsRepository }),
      MAX_FILE_SIZE_DEFAULT_MB
    ) *
    1024 *
    1024;
  if (measuredSize >= maxBytes) return 'file_too_large';

  if (owner) {
    try {
      await checkStorageLimitForFile(owner, measuredSize, organizationId ?? undefined, id =>
        organizationRepository.findById(id)
      );
    } catch (error) {
      if (error instanceof StorageLimitError) return 'storage_limit_exceeded';
      throw error;
    }
  }
  return null;
};

/**
 * Discards a rejected landing: deletes the object and soft-deletes its still-pending row, so it is
 * neither served, charged, moderated nor chunked. Returns whether the row was withdrawn.
 */
export const rejectLandedUpload = async (fabFileId: Types.ObjectId | string, objectKey: string): Promise<boolean> => {
  await getFilesStorage().delete(objectKey);
  const res = await FabFile.updateOne(
    { _id: fabFileId, status: { $ne: 'complete' }, deletedAt: null },
    { $set: { deletedAt: new Date() } }
  );
  return res.modifiedCount > 0;
};
