import type {
  IDataLakeAccessGrantRepository,
  IDataLakeProposalRepository,
  ILakeMembershipDecisionRepository,
  IDataLakeRepository,
  IDataLakeBatchRepository,
  IFabFileRepository,
  IFabFileChunkRepository,
} from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import { type ManageActor } from './manageRule';
import { resolveCanManageLake } from './authorizeLakeManage';
import { lakeMembershipScope } from './lakeMembershipScope';
import { lakeMembershipSignals } from './lakeMembership';
import { warnOnPrefixCollision } from './tagPrefixCollision';
import { strictIndexRemove, type RetrievalIndexPort } from './ports';

interface CleanupDeletedDataLakeAdapters {
  db: {
    dataLakes: Pick<IDataLakeRepository, 'findById' | 'delete' | 'find'>;
    dataLakeAccessGrants: Pick<IDataLakeAccessGrantRepository, 'listByLake' | 'removeAllForLake'>;
    /**
     * Optional: the acquisition queue (#1671). Absent -> no sweep, so a host that never wired the
     * queue is unaffected. Its rows are lake-scoped and unreviewable once the lake is gone.
     */
    dataLakeProposals?: Pick<IDataLakeProposalRepository, 'deleteForLake'>;
    /**
     * Optional for the same reason as `dataLakeProposals`: the membership-repair decisions (#2245)
     * are lake-scoped, and a host that never wired the repair has no rows to sweep.
     */
    lakeMembershipDecisions?: Pick<ILakeMembershipDecisionRepository, 'deleteForLake'>;
    batches: Pick<IDataLakeBatchRepository, 'find' | 'delete'>;
    fabFiles: Pick<IFabFileRepository, 'findIdsByDataLakeTag' | 'hardDeleteByIds' | 'findById' | 'pullTagsByFabFileId'>;
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
 * lake in 'purging' and a DLQ retry re-runs it without error or double-deletion (delete-by-id and
 * deleteMany are no-ops on already-purged data). Fan-outs are chunked (chunkSize) so a large lake
 * stays inside the Lambda timeout. Owner or admin only.
 *
 * Retrieval-index removal is the one step deliberately allowed to abort the sweep, which is why it
 * runs first. See `strictIndexRemove` in ports.ts for that posture and what it does not cover.
 */
export const cleanupDeletedDataLake = async (
  actor: ManageActor,
  dataLakeId: string,
  { db, retrievalIndex, shredMemory, logger, chunkSize = DEFAULT_CLEANUP_CHUNK_SIZE }: CleanupDeletedDataLakeAdapters
): Promise<void> => {
  const existing = await db.dataLakes.findById(dataLakeId);
  if (!existing) {
    // Already gone - idempotent success.
    return;
  }
  if (!(await resolveCanManageLake(existing, actor, { db }))) {
    throw new BadRequestError('You do not have permission to clean up this data lake');
  }
  // 'purging' is the normal arrival state since #1744 - the route claims it at accept time, before
  // this message is enqueued. 'deleted' stays valid for two reasons, and BOTH are load-bearing:
  // messages enqueued before that change are still in flight, and a DLQ replay of a sweep that was
  // released back to 'deleted' must run rather than fail on arrival. Narrowing this to one value
  // would make the admin replay path (api/admin/dlq/replay.ts, which serves this queue - see
  // dlqRegistry) decorative, and DLQ replay is the whole recovery story for a stuck purge.
  if (existing.status !== 'purging' && existing.status !== 'deleted') {
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
  await db.fabFiles.hardDeleteByIds(fileIds);

  // 3b. Whatever the predicate STILL names is exactly that spared mid-sweep joiner, and sparing it
  // is only half a decision: step 5 deletes the lake, so its prefix tag would outlive the lake it
  // points at. A later lake claiming the same prefix then adopts it silently, because the
  // create-time collision guard (`findCollidingPrefixLakes`) only compares against lakes that
  // still exist. Clearing this lake's signals off the survivor is what makes the sparing durable:
  // the file keeps its bytes and its chunks, and stops being a member of a lake that is gone.
  //
  // Runs BEFORE the lake record goes, so a throw here aborts with the lake still in 'purging' (the
  // status the accept claimed - NOT 'deleted', so it is not restorable here) and a DLQ retry
  // re-runs the whole sweep - by then the survivor is an ordinary member, resolved up
  // front and torn down with its chunks and index entry like any other.
  const survivors = await db.fabFiles.findIdsByDataLakeTag(scope);
  await inChunks(survivors, chunkSize, async id => {
    const file = await db.fabFiles.findById(id);
    const { inLake, tagsToPull } = lakeMembershipSignals(existing, file);
    if (file && inLake) await db.fabFiles.pullTagsByFabFileId(file.id, tagsToPull);
  });

  // 4. Delete the lake's batches (chunked, same rationale as the chunk sweep above).
  const batches = await db.batches.find({ dataLakeId });
  await inChunks(batches, chunkSize, b => db.batches.delete(b.id));

  // 4b. Cascade-remove the lake's access grants so the purge leaves none orphaned (the grant model
  // has no TTL/FK, so this is the only sweep). Idempotent: removeAllForLake is a no-op once the rows
  // are gone, so a DLQ retry is safe. Runs before the lake record delete for the same
  // recoverable-on-failure ordering as the rest of the sweep.
  await db.dataLakeAccessGrants.removeAllForLake(dataLakeId);

  // 4c. Cascade-drop the lake's acquisition proposals for the same reason: a proposal outliving its
  // lake is unreviewable by anyone, and its tombstones guard a source identity that no longer has a
  // destination. Idempotent, so a DLQ retry is safe.
  await db.dataLakeProposals?.deleteForLake(dataLakeId);

  // 4d. And the membership-repair decisions (#2245), for the same reason once more: a ruling about a
  // duplicated name in a lake that no longer exists is unreadable by every surface and guards
  // nothing. Idempotent.
  await db.lakeMembershipDecisions?.deleteForLake(dataLakeId);

  // 5. Delete the lake record last, so a mid-sweep failure leaves it recoverable/re-runnable.
  await db.dataLakes.delete(dataLakeId);
};
