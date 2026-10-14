import { generatedCopyKeyOf, type IFabFileDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export type ObjectStorage = { delete: (path: string) => Promise<unknown> };

export type StoredObjectBuckets = {
  files: ObjectStorage;
  /** The generated-content bucket. Absent, a file's inline-playback copy is left behind (and logged). */
  generated?: ObjectStorage;
};

/**
 * Removes every stored object a deleted file owns: its own object in the files bucket and, for an in-chat
 * generated asset, the generated-bucket copy chat plays inline (`sourceMetadata.generatedCopyKey`).
 * Shared by the single-file delete, the notebook delete and the delete-all route so they cannot drift.
 * A moderation-blocked file keeps its objects: they are legal-hold evidence (see FabFileModel.hardDeleteByIds).
 */
export async function deleteStoredObjects(
  files: ReadonlyArray<Pick<IFabFileDocument, 'id' | 'filePath' | 'sourceMetadata' | 'moderationStatus'>>,
  buckets: StoredObjectBuckets,
  logger: { warn: (message: string, ...args: unknown[]) => void } = Logger.globalInstance
): Promise<void> {
  const deletes: Promise<unknown>[] = [];
  for (const file of files) {
    if (file.moderationStatus === 'blocked') {
      logger.warn('[deleteStoredObjects] keeping the objects of a blocked file (legal hold)', { fileId: file.id });
      continue;
    }
    if (file.filePath) deletes.push(buckets.files.delete(file.filePath));
    const copyKey = generatedCopyKeyOf(file);
    if (!copyKey) continue;
    if (buckets.generated) {
      deletes.push(buckets.generated.delete(copyKey));
    } else {
      logger.warn('[deleteStoredObjects] no generated storage wired; inline copy left behind', {
        fileId: file.id,
        copyKey,
      });
    }
  }
  await Promise.all(deletes);
}
