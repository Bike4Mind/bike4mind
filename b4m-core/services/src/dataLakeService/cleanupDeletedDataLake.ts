import type {
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
  IFabFileChunkRepository,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { canManageLake } from './authorizeLakeWrite';
import { lakeMembershipScope } from './lakeMembershipScope';
import { warnOnPrefixCollision } from './tagPrefixCollision';
import { strictIndexRemove, type RetrievalIndexPort } from './ports';

interface CleanupDeletedDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'delete' | 'find'>;
    batches: Pick<IDataLakeBatchRepository, 'find' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'findIdsByDataLakeTag' | 'hardDeleteByIds'>;
    fabFileChunks: Pick<IFabFileChunkRepository, 'deleteManyByFabFileId'>;
  };
  retrievalIndex?: RetrievalIndexPort;
  /**
   * Crypto-shred the lake's memory profile (#1440): destroy the `{ kind: 'lake' }` principal's DEK and
   * mark its ledger shredded. Injected because the ledger/keyring live in the app layer. Optional so a
   * host that never wired lake memory is unaffected; when present it runs BEFORE the file sweep, and a
   * failure aborts (retries) rather than orphaning an unreadable-but-undeletable ledger + DEK behind the
   * deleted lake.
   */
  shredMemory?: (args: { datalakeTag: string; ownerUserId: string }) => Promise<void>;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
  /** Bounds peak concurrency of the per-file/per-batch deletes (background consumer sets this). */
  chunkSize?: number;
}

/** Default fan-out chunk size - bounds peak Mongo concurrency for a large lake's sweep. */
const DEFAULT_CLEANUP_CHUNK_SIZE = 100;

/** Run `fn` over `items` in sequential slices of `size`, so peak concurrency stays bounded. */
async function inChunks<T>(items: T[], size: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}

/**
 * Phase 2 of permanent delete: the retry-safe hard-delete sweep over chunks, files,
 * batches, and the lake record. Runs in the background cleanup queue consumer (enqueued by an
 * explicit user/admin action), which is why it's idempotent - a partially-failed run leaves the
 * lake in 'deleted' and a DLQ retry re-runs it without error or double-deletion (delete-by-id and
 * deleteMany are no-ops on already-purged data). Fan-outs are chunked (chunkSize) so a large lake
 * stays inside the Lambda timeout. Owner or admin only.
 *
 * Retrieval-index removal is the one step deliberately allowed to abort the sweep, which is why it
 * runs first. See `strictIndexRemove` in ports.ts for that posture and what it does not cover.
 */
export const cleanupDeletedDataLake = async (
  actor: { userId: string; isAdmin: boolean },
  dataLakeId: string,
  { db, retrievalIndex, shredMemory, logger, chunkSize = DEFAULT_CLEANUP_CHUNK_SIZE }: CleanupDeletedDataLakeAdapters
): Promise<void> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    // Already gone - idempotent success.
    return;
  }
  if (!canManageLake(existing, actor)) {
    throw new BadRequestError('Only the creator can clean up this data lake');
  }
  if (existing.status !== 'deleted') {
    throw new BadRequestError('Data lake must be soft-deleted before cleanup');
  }

  await warnOnPrefixCollision(db, existing, logger);
  const scope = lakeMembershipScope(existing);
  // Deliberately unbounded, unlike restore's stamp-keyed reversal: purge destroys the lake and
  // everything the membership predicate still names, a member the creator deleted on their own
  // included. The stamp bound only stops restore from reviving what it never deleted; it is not a
  // claim that such a file outlives its lake.
  const fileIds = await db.fabFiles.findIdsByDataLakeTag(scope);

  // 1. Retrieval index first, and strict: a throw here must cost no progress (see ports.ts).
  await strictIndexRemove(retrievalIndex, { scope, fabFileIds: fileIds });

  // 1b. Crypto-shred the lake's memory profile (#1440) BEFORE deleting the lake record - otherwise the
  // `{ kind: 'lake' }` ledger and its DEK would survive the delete, unreadable but also undeletable
  // (the memory API 400s on `lake`), leaving facts extracted from a deleted lake alive forever. A throw
  // here aborts the sweep so a DLQ retry re-runs it (shred is idempotent: destroyDek then markShredded).
  if (shredMemory && existing.datalakeTag && existing.createdByUserId) {
    await shredMemory({ datalakeTag: existing.datalakeTag, ownerUserId: existing.createdByUserId });
  }

  // 2. Delete chunks for every member file (covers soft-deleted files too). Chunked so a large
  // lake doesn't fan out unbounded (Lambda timeout/memory); each delete is a no-op on
  // already-purged data, so a DLQ retry resumes safely.
  await inChunks(fileIds, chunkSize, id => db.fabFileChunks.deleteManyByFabFileId(id));

  // 3. Hard-delete exactly the ids resolved above, NOT by re-running the membership predicate.
  // Re-resolving would also destroy anything that became a member since - a file the creator
  // tagged mid-sweep - leaving its chunks behind and its index entry unrequested. It survives
  // this run instead, which is the recoverable direction.
  //
  // The survivor is left carrying a prefix tag whose lake step 5 then deletes, and nothing
  // reconciles that: a later lake claiming the same prefix would silently adopt it, since the
  // create-time collision guard only compares against lakes that still exist.
  await db.fabFiles.hardDeleteByIds(fileIds);

  // 4. Delete the lake's batches (chunked, same rationale as the chunk sweep above).
  const batches = await db.batches.find({ dataLakeId });
  await inChunks(batches, chunkSize, b => db.batches.delete(b.id));

  // 5. Delete the lake record last, so a mid-sweep failure leaves it recoverable/re-runnable.
  await db.dataLakes.delete(dataLakeId);
};
