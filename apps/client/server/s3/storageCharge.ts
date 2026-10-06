import { FabFile, User } from '@bike4mind/database';
import type { ClientSession } from 'mongoose';

/**
 * Claims the right to charge the bytes of an object written at `uploadedAt` to its FabFile's owner,
 * by advancing `storageChargedAt` with a compare-and-set. Only an upload newer than the last charge
 * wins, so a redelivered S3 event, or the event for a notebook import's object that the import
 * already charged in its own transaction (chargeImportedKnowledgeStorage), charges nothing - while a
 * later content rewrite to the same path still does.
 */
export const claimStorageCharge = async (
  fabFileId: unknown,
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
 * Charges the owner for the knowledge rows an import wrote, inside the import's own transaction:
 * its quota gate reads `currentStorageSize`, so leaving the charge to the S3 event - which gives up
 * before these rows are visible - let every later import measure against headroom already spent.
 * Writing the user document here also makes two overlapping imports write-conflict, so the retry
 * re-gates against the committed size. Returns the bytes charged.
 */
export const chargeImportedKnowledgeStorage = async (
  userId: string,
  filePaths: string[],
  session: ClientSession
): Promise<number> => {
  if (!filePaths.length) return 0;

  const filter = { userId, filePath: { $in: filePaths }, storageChargedAt: null };
  const rows = await FabFile.find(filter, { fileSize: 1 }).session(session);
  const charged = rows.reduce((sum, row) => sum + (row.fileSize ?? 0), 0);

  await FabFile.updateMany(
    { _id: { $in: rows.map(row => row._id) } },
    { $set: { storageChargedAt: new Date() } },
    { session }
  );
  if (charged > 0) {
    await User.updateOne({ _id: userId }, { $inc: { currentStorageSize: charged } }, { session });
  }
  return charged;
};
