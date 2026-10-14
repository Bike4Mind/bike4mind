import { generatedCopyKeyOf, type IChatHistoryItemRepository, type IFabFileDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export type ObjectStorage = { delete: (path: string) => Promise<unknown> };

/** The generated-content bucket, plus the reply lookup that tells whether another notebook still shows a copy. */
export type GeneratedCopyStore = {
  storage: ObjectStorage;
  quests: Pick<IChatHistoryItemRepository, 'findSessionIdsByImage'>;
};

export type StoredObjectBuckets = {
  files: ObjectStorage;
  /** Absent, a file's inline-playback copy is left behind (and logged). */
  generated?: GeneratedCopyStore;
};

type StoredFile = Pick<IFabFileDocument, 'id' | 'filePath' | 'sourceMetadata' | 'moderationStatus'>;
type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

/**
 * Removes every stored object a deleted file owns: its own object in the files bucket and, for an in-chat
 * generated asset, the generated-bucket copy chat plays inline (`sourceMetadata.generatedCopyKey`).
 * Shared by the single-file delete, the notebook delete and the delete-all route so they cannot drift.
 * A moderation-blocked file keeps its objects: they are legal-hold evidence (see FabFileModel.hardDeleteByIds).
 */
export async function deleteStoredObjects(
  files: ReadonlyArray<StoredFile>,
  buckets: StoredObjectBuckets,
  logger: WarnLogger = Logger.globalInstance
): Promise<void> {
  await Promise.all(files.map(file => deleteFileObjects(file, buckets, logger)));
}

async function deleteFileObjects(file: StoredFile, buckets: StoredObjectBuckets, logger: WarnLogger) {
  if (file.moderationStatus === 'blocked') {
    logger.warn('[deleteStoredObjects] keeping the objects of a blocked file (legal hold)', { fileId: file.id });
    return;
  }
  const copyKey = generatedCopyKeyOf(file);
  await Promise.all([
    file.filePath ? buckets.files.delete(file.filePath) : undefined,
    copyKey ? deleteGeneratedCopy(file, copyKey, buckets.generated, logger) : undefined,
  ]);
}

async function deleteGeneratedCopy(
  file: StoredFile,
  copyKey: string,
  generated: GeneratedCopyStore | undefined,
  logger: WarnLogger
) {
  if (!generated) {
    logger.warn('[deleteStoredObjects] no generated storage wired; inline copy left behind', {
      fileId: file.id,
      copyKey,
    });
    return;
  }
  if (await isShownInAnotherNotebook(file, copyKey, generated.quests)) return;
  await generated.storage.delete(copyKey);
}

// Clone, fork and snip copy a reply's `quest.images` verbatim, so another notebook can play the same key. Without
// a notebook link of its own, any reply showing the key counts as another notebook's.
async function isShownInAnotherNotebook(
  file: StoredFile,
  copyKey: string,
  quests: GeneratedCopyStore['quests']
): Promise<boolean> {
  const ownSessionId = file.sourceMetadata?.sessionId;
  const sessionIds = await quests.findSessionIdsByImage(copyKey);
  return sessionIds.some(sessionId => sessionId !== ownSessionId);
}
