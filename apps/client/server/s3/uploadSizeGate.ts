import { adminSettingsRepository, FabFile, organizationRepository, User } from '@bike4mind/database';
import { chargedBytes, StorageLimitError, type StorageChargeFields } from '@bike4mind/common';
import { checkStorageLimitForOwner, getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import type { ILogger } from '@bike4mind/observability';
import { getFilesStorage } from '@server/utils/storage';
import { MAX_FILE_SIZE_DEFAULT_MB } from '@server/utils/maxFileSizeDefault';
import type { Types } from 'mongoose';

export type LandedUploadRejection = 'larger_than_declared' | 'file_too_large' | 'storage_limit_exceeded';

/** The FabFile fields the gate reads, as the event handler loaded them (before it marks the row complete). */
export interface LandedUploadRow extends StorageChargeFields {
  _id: Types.ObjectId | string;
  userId: string;
  organizationId?: string | null;
  fileSize?: number | null;
  clientUpload?: boolean | null;
  uploadRejectedAt?: Date | null;
}

type GateLogger = Pick<ILogger, 'warn' | 'error'>;

/**
 * Judges a client upload by the size it measured, before the row is marked complete: the create-time
 * size and quota checks ran on the size the uploader declared, so the object must not be larger
 * than that, must stay under MaxFileSize, and must fit the owner's (or owning org's) storage limit.
 * Only a first landing of a row minted for a client PUT (IFabFile.clientUpload) is judged. A
 * server-side door (agent avatars, connector ingest, fabFileService content writes, notebook import)
 * writes bytes it holds and does its own admission, and a later write to a complete row is a
 * server-side rewrite, which its own commit charges (commitContentRewrite).
 */
export const judgeLandedUpload = async (
  row: LandedUploadRow,
  measuredSize: number,
  logger: GateLogger
): Promise<LandedUploadRejection | null> => {
  if (row.status === 'complete' || !row.clientUpload) return null;

  // An unknown (0/unset) declaration is left to the size and quota checks below.
  const declaredSize = row.fileSize;
  if (declaredSize && measuredSize > declaredSize) return 'larger_than_declared';

  try {
    const maxBytes =
      getSettingsValue(
        'MaxFileSize',
        await getSettingsMap({ adminSettings: adminSettingsRepository }),
        MAX_FILE_SIZE_DEFAULT_MB
      ) *
      1024 *
      1024;
    if (measuredSize >= maxBytes) return 'file_too_large';

    const owner = await User.findById(row.userId);
    // Bytes already charged for this row (a redelivery can read it before it went complete) are in
    // the balance the limit reads, so only the rest is new.
    // Check-then-charge, like the create-time check: landings racing for one owner can each pass
    // before either is charged (the charge comes after the row is complete, and the user counter is
    // a load-modify-save), so the overshoot is bounded by those landings, each within MaxFileSize.
    if (owner) {
      await checkStorageLimitForOwner(
        { user: owner, organizationId: row.organizationId ?? undefined },
        measuredSize - chargedBytes(row),
        id => organizationRepository.findById(id)
      );
    }
  } catch (error) {
    if (error instanceof StorageLimitError) return 'storage_limit_exceeded';
    // A declared size already passed the create-time checks and bounds this object, so a failed
    // read admits it rather than stranding the row on 'pending'.
    if (!declaredSize) throw error;
    logger.error(`Upload size gate could not read limits for ${row._id}; admitting within its declared size`, error);
  }
  return null;
};

/**
 * Discards a rejected landing: soft-deletes its still-pending row, then deletes the object, so it is
 * neither served, charged, moderated nor chunked. A row that went complete meanwhile keeps its
 * object. Rejected tombstones remain eligible on redelivery, including after a failed delete or
 * a replay of the presigned PUT. Returns whether this is a rejected row, never an accepted one.
 */
export const rejectLandedUpload = async (fabFileId: Types.ObjectId | string, objectKey: string): Promise<boolean> => {
  const withdrawn = await FabFile.findOneAndUpdate(
    { _id: fabFileId, status: { $ne: 'complete' }, deletedAt: null },
    { $set: { deletedAt: new Date(), uploadRejectedAt: new Date() } },
    { new: true }
  );
  const rejected =
    withdrawn ??
    (await FabFile.findOne({ _id: fabFileId, status: { $ne: 'complete' }, uploadRejectedAt: { $ne: null } }, null, {
      includeDeleted: true,
    }));
  if (!rejected) return false;
  await getFilesStorage().delete(objectKey);
  return true;
};

/**
 * The measured-size gate every upload landing runs: the hosted S3 event (objectCreated.ts), the
 * self-host MinIO webhook (pages/api/internal/s3/object-created.ts) and the self-host upload proxy
 * (pages/api/files/[id]/upload.ts). Returns false when the upload was rejected and withdrawn.
 */
export const admitLandedUpload = async (
  row: LandedUploadRow,
  measuredSize: number,
  objectKey: string,
  logger: GateLogger
): Promise<boolean> => {
  if (row.uploadRejectedAt) {
    await rejectLandedUpload(row._id, objectKey);
    return false;
  }
  const rejection = await judgeLandedUpload(row, measuredSize, logger);
  if (!rejection) return true;
  logger.warn(`Rejecting upload ${objectKey} (${measuredSize} bytes): ${rejection}`);
  return !(await rejectLandedUpload(row._id, objectKey));
};
