import type {
  DataLakeMembershipScope,
  DataLakeSweptFile,
  IDataLakeFindingRepository,
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  ISessionRepository,
  IUserRepository,
} from '@bike4mind/common';
import {
  bestEffortAdjustOwnerStorage,
  groupStorageDeltaByOwner,
  strictIndexRemove,
  type RetrievalIndexPort,
} from './ports';

/**
 * The subset of a FabFile row this sweep needs. Callers resolve the connection-scoped list
 * themselves (Drive's caller uses `findByDriveConnectionIdInDataLake` with `includeDeleted` -
 * archivedAt/deletedAt-blind, unlike its sync-reconcile default - so a disconnected archived
 * lake's members are still reached; a future connector - the GitHub connector this helper
 * is deliberately shaped for - supplies its own equivalent finder), so this stays uncoupled from
 * any one connector's lookup predicate.
 */
export type PurgeableConnectionFile = Pick<
  IFabFileDocument,
  'id' | 'userId' | 'fileSize' | 'filePath' | 'versions' | 'tags'
>;

export interface PurgeDataLakeConnectionFilesAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'hardDeleteOneById'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'deleteManyByFabFileId' | 'clearRetrievalIndexConfirmedByFabFileIds'>;
    /** Optional, like the lake-wide sweeps: a caller with no reason to exercise quota accounting (a script, a test) simply gets no adjustment. */
    users?: Pick<IUserRepository, 'incrementCurrentStorage'>;
    /**
     * Optional, like `cleanupDeletedDataLake`'s own use of this port: a host that never ran
     * detection has no rows to sweep. Wired here for the same reason it is wired there - a
     * finding quotes its source, so a row left behind keeps an excerpt of a document this call
     * just destroyed, unswept by anything short of a later whole-lake purge.
     */
    dataLakeFindings?: Pick<IDataLakeFindingRepository, 'deleteForPurgedDocuments'>;
    /**
     * Unlink each deleted file from every chat session's `knowledgeIds` - the same unlink
     * `purgeDataLakeDocument` performs, but as an atomic `$pull`: this sweep deletes files
     * concurrently, and a read-modify-write per file would let two files attached to the same
     * session overwrite each other's removal. Optional
     * because a host with no reason to exercise it (a script, a test) simply skips the unlink;
     * omitting it in production leaves every chat that had one of these files attached pointing at
     * a row that no longer exists (a stale attachment chip, an unclassifiable session).
     */
    sessions?: Pick<ISessionRepository, 'pullKnowledgeIds'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  /** The object store holding each file's bytes. Optional for the same reason as cleanupDeletedDataLake's `storage`: a host that never wires it is unaffected structurally, but every purged file's bytes are then orphaned and still billed - see the unwired warning below. */
  storage?: { delete: (path: string) => Promise<unknown> };
  /**
   * Crypto-shred the facts each deleted file contributed to the memory ledger - the per-document
   * sibling of `purgeDataLakeDocument`'s own `shredDocumentMemory` port (see that adapter for the
   * full contract: resolving a file's OTHER member lakes from its tags is the host's job there, and
   * here). Optional for the same reason it is optional there (the service cannot reach the ledger
   * repository) and because it is new scope over this sweep's original file/chunk/index/storage
   * contract - a host that leaves it unwired keeps recalling beliefs sourced from a Drive-purged
   * document, the same gap `purgeDataLakeDocument` had before that port existed. Called ONCE PER
   * deleted file (not batched, unlike `dataLakeFindings` above), gated on THAT file's own
   * `hardDeleteOneById` succeeding - mirroring the single-document door's gate on `documentDeleted`
   * rather than the whole sweep's outcome, so one file's storage-delete failure in a chunk cannot
   * skip or block another file's shred in the same `Promise.all`.
   */
  shredDocumentMemory?: (args: { tagNames: string[]; fabFileId: string; ownerUserId: string }) => Promise<void>;
  logger?: { warn: (msg: string, ...args: unknown[]) => void; error: (msg: string, ...args: unknown[]) => void };
  /** Bounds peak concurrency of the per-file delete fan-out, mirroring cleanupDeletedDataLake's chunked sweep. */
  chunkSize?: number;
}

export interface PurgeDataLakeConnectionFilesResult {
  /** Rows this call actually hard-deleted (excludes any id a concurrent purge already removed). */
  filesPurged: number;
  /** Stored objects (current key + every prior version) this call actually deleted. */
  storageObjectsDeleted: number;
}

/** Bounds peak Mongo/object-store concurrency for a large connection's sweep. */
const DEFAULT_CHUNK_SIZE = 100;

/**
 * Purge a pre-resolved, connection-scoped subset of a lake's files - their rows, chunks,
 * retrieval-index entries, stored objects and (when wired) findings that quote them and chat
 * sessions that reference them - WITHOUT touching the lake record, its batches, access grants,
 * proposals or research configs. This is the CONNECTION-scoped counterpart to
 * `cleanupDeletedDataLake`'s file/chunk/index/storage sweep: that one tears down a whole lake;
 * this one tears down one connector's contribution to a lake that keeps existing (e.g. disconnecting
 * Google Drive must not touch a sibling connection's files or a manually-uploaded file in the same
 * lake).
 *
 * Deliberately NOT a loop calling `purgeDataLakeDocument` per file. That door's per-document
 * ownership gate (only the file's own owner, or a platform admin, may purge it) and its
 * transactional quota-refund plumbing are tuned for a single user-initiated delete, not a bulk
 * sweep an org owner/manager triggers by disconnecting a shared ingest source - a contributor's
 * own upload is a full lake member with no ownership conjunct on the meta-tag arm (see
 * `lakeMembershipSignals`), and this sweep must remove it regardless of who owns it, the same
 * posture `cleanupDeletedDataLake` already takes for a whole-lake purge. Mirroring that sweep's
 * inner loop instead keeps the two purges consistent and avoids paying a per-file transaction for
 * what is already a bounded, already-scoped batch.
 *
 * Retrieval-index removal runs first and strictly, matching `cleanupDeletedDataLake`'s own
 * ordering rationale (see `strictIndexRemove`): a throw there costs no progress, and a retry sees
 * the same files because the caller re-resolves its connection-scoped list fresh rather than this
 * helper caching anything across a failure.
 *
 * The object-store delete for a given file is deliberately UNCAUGHT, like `cleanupDeletedDataLake`'s:
 * a throw aborts the sweep before that file's row goes, so a retry still finds it via the caller's
 * connection-scoped lookup instead of a hard-deleted row over bytes that were never removed.
 *
 * `hardDeleteOneById`'s own return decides whether a file's bytes count toward the storage refund -
 * not merely "this call attempted the delete" - so two concurrent sweeps racing the same connection
 * (a retry racing the original, say) can never refund the same owner's bytes twice.
 */
export const purgeDataLakeConnectionFiles = async (
  scope: DataLakeMembershipScope,
  files: PurgeableConnectionFile[],
  {
    db,
    retrievalIndex,
    storage,
    shredDocumentMemory,
    logger,
    chunkSize = DEFAULT_CHUNK_SIZE,
  }: PurgeDataLakeConnectionFilesAdapters
): Promise<PurgeDataLakeConnectionFilesResult> => {
  if (files.length === 0) {
    return { filesPurged: 0, storageObjectsDeleted: 0 };
  }

  const fileIds = files.map(f => f.id);
  await strictIndexRemove(retrievalIndex, { scope, fabFileIds: fileIds }, db.fabFileChunks, logger);

  if (!storage) {
    logger?.warn(
      '[dataLake] connection-scoped file purge is destroying documents with no storage adapter wired - their stored objects will be orphaned',
      { fileCount: files.length }
    );
  }

  const isStorageKey = (path: unknown): path is string => typeof path === 'string' && path.length > 0;
  let storageObjectsDeleted = 0;
  const deletedFiles: DataLakeSweptFile[] = [];

  try {
    for (let i = 0; i < files.length; i += chunkSize) {
      const slice = files.slice(i, i + chunkSize);
      // BEFORE the slice's rows go, mirroring cleanupDeletedDataLake's own ordering: once a row is
      // hard-deleted its id is no longer resolvable by any finder, so a findings sweep placed
      // after would permanently miss whatever this slice removes on the next call.
      await db.dataLakeFindings?.deleteForPurgedDocuments(slice.map(file => file.id));
      await Promise.all(
        slice.map(async file => {
          if (storage) {
            const currentKey = isStorageKey(file.filePath) ? file.filePath : null;
            // EVERY stored key, not just the current one - an AI-edited file's earlier revisions
            // each sit under their own object key (mirrors cleanupDeletedDataLake/purgeDataLakeDocument).
            const versionKeys = Array.from(
              new Set((file.versions ?? []).map(version => version?.filePath).filter(isStorageKey))
            ).filter(path => path !== currentKey);
            for (const path of versionKeys) {
              await storage.delete(path);
              storageObjectsDeleted++;
            }
            if (currentKey) {
              await storage.delete(currentKey);
              storageObjectsDeleted++;
            }
          }
          const deletedByThisCall = await db.fabFiles.hardDeleteOneById(file.id);
          await db.fabFileChunks.deleteManyByFabFileId(file.id);
          if (deletedByThisCall) {
            deletedFiles.push({ id: file.id, userId: file.userId, fileSize: file.fileSize });
            const tagNames = (file.tags ?? [])
              .map(tag => tag?.name)
              .filter((name): name is string => typeof name === 'string');
            await shredDocumentMemory?.({ tagNames, fabFileId: file.id, ownerUserId: file.userId });
            // Own try/catch, like purgeDataLakeDocument's own unlink: a failure here must not cost
            // another file in the same chunk its shred or its refund, and the file is gone either way
            // (there is no retry door left for the unlink specifically once the row has hard-deleted).
            try {
              await db.sessions?.pullKnowledgeIds([file.id]);
            } catch (error) {
              logger?.error('[dataLake] connection purge removed a file but could not unlink it from sessions', {
                fabFileId: file.id,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }
        })
      );
    }
  } finally {
    // In `finally`, not after the loop: a throw partway (an uncaught storage.delete failure, or a
    // later chunk failing) must not cost the refund for files earlier chunks - or earlier-settled
    // tasks in the same failing chunk's Promise.all - already hard-deleted. `deletedFiles` only
    // ever holds rows this call actually removed, so refunding whatever it has so far is correct
    // whether the loop finished or not.
    await bestEffortAdjustOwnerStorage(db.users, groupStorageDeltaByOwner(deletedFiles, -1), logger);
  }

  return { filesPurged: deletedFiles.length, storageObjectsDeleted };
};
