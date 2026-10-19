import { changeStorageSize, FabFile, userRepository } from '@bike4mind/database';
import { chargedBytes, type IUserDocument } from '@bike4mind/common';
import type { ClientSession, Types } from 'mongoose';

/**
 * Claims the right to charge the bytes of an object written at `uploadedAt` to its FabFile's owner,
 * by advancing `storageChargedAt` with a compare-and-set. Only an upload newer than the last charge
 * wins, so a redelivered S3 event, or the event for a notebook import's object that the import
 * already stamped in its own transaction (stampImportedKnowledgeRows), charges nothing. A winning
 * claim also writes `fileSize: size` and returns `size - chargedBytes(preImage)`, the same move a
 * content rewrite's commit makes (commitContentRewrite in
 * b4m-core/services/src/fabFileService/rewriteStorage.ts), so a rewrite's event and its commit add up
 * to the new size in either order. Returns null when the claim lost.
 *
 * `statusBeforeUpload` is the row's status as the event handler read it, before it marked the row
 * `complete`: the charge rule reads `status`, so judging the pre-image by the handler's own flip would
 * count a legacy no-status row as already charged and undercharge it by its old size.
 */
export const claimStorageCharge = async (
  fabFileId: Types.ObjectId | string,
  uploadedAt: Date,
  size: number,
  statusBeforeUpload: string | null | undefined,
  session?: ClientSession
): Promise<number | null> => {
  const pre = await FabFile.findOneAndUpdate(
    { _id: fabFileId, $or: [{ storageChargedAt: null }, { storageChargedAt: { $lt: uploadedAt } }] },
    { $set: { storageChargedAt: uploadedAt, fileSize: size } },
    {
      new: false,
      projection: { fileSize: 1, storageChargedAt: 1, createdAt: 1 },
      ...(session ? { session } : {}),
    }
  ).lean();
  return pre ? size - chargedBytes({ ...pre, status: statusBeforeUpload }) : null;
};

/**
 * Charges an uploaded object's bytes to `user` once per write, through claimStorageCharge.
 * Mutates `user` only; the caller saves it in the same `session`. A won claim also records `size` as
 * the row's `fileSize`. Shared by the hosted S3 event
 * (objectCreated.ts) and the self-host MinIO webhook (pages/api/internal/s3/object-created.ts).
 */
export const chargeUploadedObject = async (
  fabFileId: Types.ObjectId | string,
  user: IUserDocument,
  size: number,
  uploadedAt: Date,
  statusBeforeUpload: string | null | undefined,
  session: ClientSession
): Promise<boolean> => {
  const delta = await claimStorageCharge(fabFileId, uploadedAt, size, statusBeforeUpload, session);
  if (delta === null) return false;
  await changeStorageSize(user, delta);
  return true;
};

/**
 * Marks the knowledge rows an import wrote as charged, inside the import's own transaction, so the
 * S3 event for those uploads (which fired before the rows were visible) charges nothing. Touches only
 * the import's own rows: writing the user document here would make any concurrent write to it
 * (credits, presence, uploads) force the whole import to re-run. The bytes are debited afterwards by
 * chargeStampedKnowledgeStorage. Returns the stamp that identifies this import's rows.
 */
export const stampImportedKnowledgeRows = async (
  userId: string,
  filePaths: string[],
  session: ClientSession
): Promise<Date> => {
  const stamp = new Date();
  if (filePaths.length) {
    await FabFile.updateMany(
      { userId, filePath: { $in: filePaths }, storageChargedAt: null },
      { $set: { storageChargedAt: stamp } },
      { session }
    );
  }
  return stamp;
};

/**
 * Debits the owner for the rows stampImportedKnowledgeRows stamped, after the import commits. Its
 * quota gate reads `currentStorageSize`, and the S3 event gives up before these rows are visible, so
 * without this every later import measures against headroom already spent. Two imports that overlap
 * can still both pass the gate; the overshoot is bounded by one import's admitted bytes. Returns the
 * bytes charged.
 */
export const chargeStampedKnowledgeStorage = async (
  userId: string,
  filePaths: string[],
  stamp: Date
): Promise<number> => {
  if (!filePaths.length) return 0;

  const rows = await FabFile.find({ userId, filePath: { $in: filePaths }, storageChargedAt: stamp }, { fileSize: 1 });
  const charged = rows.reduce((sum, row) => sum + (row.fileSize ?? 0), 0);
  if (charged > 0) await userRepository.incrementCurrentStorage(userId, charged);
  return charged;
};
