import { FabFile, GeneratedFileCleanupModel, generatedFileCleanupPathSchema } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { getFilesStorage } from './storage/index';

export async function rememberGeneratedFileCleanup(
  filePath: string,
  { ambiguousUpload = false }: { ambiguousUpload?: boolean } = {}
): Promise<void> {
  const path = generatedFileCleanupPathSchema.parse(filePath);
  await GeneratedFileCleanupModel.updateOne(
    { filePath: path },
    {
      $setOnInsert: { filePath: path, createdAt: new Date() },
      ...(ambiguousUpload ? { $set: { ambiguousUpload: true } } : {}),
    },
    { upsert: true, maxTimeMS: 5000 }
  );
}

export async function deleteRememberedGeneratedFile(filePath: string): Promise<boolean> {
  const path = generatedFileCleanupPathSchema.parse(filePath);
  const receipt = await GeneratedFileCleanupModel.findOne({ filePath: path })
    .select('ambiguousUpload')
    .maxTimeMS(5000)
    .lean();
  if (!receipt) return false;
  const referenced = await FabFile.findOne({
    $and: [
      { $or: [{ filePath: path }, { 'versions.filePath': path }] },
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
    .maxTimeMS(5000);
  if (referenced) {
    await GeneratedFileCleanupModel.deleteOne({ filePath: path }).maxTimeMS(5000);
    return false;
  }
  if (receipt.ambiguousUpload) {
    // A rejected request may commit later; an empty listing must retain its exact-path retry anchor.
    if ((await getFilesStorage().deletePermanentlyWithCount(path)) === 0) return false;
  } else {
    await getFilesStorage().deletePermanently(path);
  }
  await GeneratedFileCleanupModel.deleteOne({ filePath: path }).maxTimeMS(5000);
  return true;
}

/** Drain exact-path receipts independently of creator existence or the organization's chosen policy. */
export async function retryGeneratedFileCleanup({
  deadline = Date.now() + 120_000,
  logger = Logger.globalInstance,
}: { deadline?: number; logger?: Pick<Logger, 'error'> } = {}): Promise<number> {
  if (Date.now() >= deadline) return 0;
  const rows = await GeneratedFileCleanupModel.find()
    .sort({ lastAttemptAt: 1, _id: 1 })
    .limit(50)
    .maxTimeMS(Math.max(1, Math.min(5000, deadline - Date.now())))
    .lean();
  let deleted = 0;
  let failures = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    await GeneratedFileCleanupModel.updateOne({ _id: row._id }, { $set: { lastAttemptAt: new Date() } }).maxTimeMS(
      5000
    );
    try {
      if (await deleteRememberedGeneratedFile(row.filePath)) deleted++;
    } catch (error) {
      failures++;
      logger.error('Generated Files cleanup failed; receipt retained for retry', { filePath: row.filePath, error });
    }
  }
  if (failures) throw new Error(`Generated Files cleanup failed for ${failures} object(s)`);
  return deleted;
}
