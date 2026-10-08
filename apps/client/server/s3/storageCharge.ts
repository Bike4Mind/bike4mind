import { FabFile, userRepository } from '@bike4mind/database';
import type { ClientSession, Types } from 'mongoose';

/**
 * Claims the right to charge the bytes of an object written at `uploadedAt` to its FabFile's owner,
 * by advancing `storageChargedAt` with a compare-and-set. Only an upload newer than the last charge
 * wins, so a redelivered S3 event, or the event for a notebook import's object that the import
 * already stamped in its own transaction (stampImportedKnowledgeRows), charges nothing - while a
 * later content rewrite to the same path still does.
 */
export const claimStorageCharge = async (
  fabFileId: Types.ObjectId | string,
  uploadedAt: Date,
  session?: ClientSession
): Promise<boolean> => {
  const res = await FabFile.updateOne(
    { _id: fabFileId, $or: [{ storageChargedAt: null }, { storageChargedAt: { $lt: uploadedAt } }] },
    { $set: { storageChargedAt: uploadedAt } },
    session ? { session } : {}
  );
  return res.modifiedCount > 0;
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
