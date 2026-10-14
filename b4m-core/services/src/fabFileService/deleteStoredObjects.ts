import {
  generatedCopyKeyOf,
  isModerationEvidenceHold,
  type IChatHistoryItemRepository,
  type IFabFileDocument,
} from '@bike4mind/common';
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

type StoredFile = Pick<
  IFabFileDocument,
  'id' | 'filePath' | 'versions' | 'sourceMetadata' | 'moderationStatus' | 'blockReason'
>;
type WarnLogger = { warn: (message: string, ...args: unknown[]) => void };

/**
 * Removes every stored object a deleted file owns: its own object in the files bucket, the retained revisions an
 * AI edit keeps under their own keys in `versions[]` (see appendEditedVersion) and, for an in-chat generated asset,
 * the generated-bucket copy chat plays inline (`sourceMetadata.generatedCopyKey`). Revisions are deleted first and
 * best-effort; a failure on `filePath` or the generated copy still rejects.
 * Shared by the single-file delete, the notebook delete and the delete-all route so they cannot drift.
 * A moderation-blocked file keeps its objects: they may be legal-hold evidence pending triage (see
 * isModerationEvidenceHold and FabFileModel.hardDeleteByIds). An unscannable-format block is not held.
 */
export async function deleteStoredObjects(
  files: ReadonlyArray<StoredFile>,
  buckets: StoredObjectBuckets,
  logger: WarnLogger = Logger.globalInstance
): Promise<void> {
  await Promise.all(files.map(file => deleteFileObjects(file, buckets, logger)));
}

async function deleteFileObjects(file: StoredFile, buckets: StoredObjectBuckets, logger: WarnLogger) {
  if (isModerationEvidenceHold(file)) {
    logger.warn('[deleteStoredObjects] keeping the objects of a blocked file (legal hold)', { fileId: file.id });
    return;
  }
  const copyKey = generatedCopyKeyOf(file);
  await deleteRetainedVersions(file, buckets.files, logger);
  // Every delete starts before any can reject, so a failed `filePath` never skips the generated copy.
  await Promise.all([
    file.filePath ? buckets.files.delete(file.filePath) : undefined,
    copyKey ? deleteGeneratedCopy(file, copyKey, buckets.generated, logger) : undefined,
  ]);
}

/**
 * Best-effort and first, so `filePath` goes last. A failed key is logged, never thrown: retained revisions are not
 * part of the quota refund (`sizeToDeduct` counts the current file only), and the row is already soft-deleted by the
 * time this runs, so nobody could retry a rejection. Rejecting would only withhold a refund for bytes that were removed.
 */
async function deleteRetainedVersions(file: StoredFile, files: ObjectStorage, logger: WarnLogger) {
  const versionKeys = new Set((file.versions ?? []).map(version => version?.filePath));
  const keys = [...versionKeys].filter(
    (key): key is string => typeof key === 'string' && key.length > 0 && key !== file.filePath
  );
  const outcomes = await Promise.allSettled(keys.map(key => files.delete(key)));
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      logger.warn('[deleteStoredObjects] could not delete a retained version; object left behind', {
        fileId: file.id,
        key: keys[index],
        reason: outcome.reason,
      });
    }
  });
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
