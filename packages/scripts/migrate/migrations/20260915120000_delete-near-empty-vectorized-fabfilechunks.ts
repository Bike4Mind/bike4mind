import { FabFile, FabFileChunk, fabFileChunkRepository, mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';
import {
  collectNearEmptyCandidates,
  planNearEmptyChunkDeletions,
  type NearEmptyChunkFilePlan,
} from '../nearEmptyChunkScan';

/**
 * Delete already-vector-bearing `fabfilechunks` rows under MIN_CHUNK_CHARS_FLOOR (#2817).
 *
 * A captured production lake had chunks as short as 1 character, already embedded, competing for
 * retrieval slots on cosine noise alone - one landed in the top-10 of 28/30 sampled queries. The
 * producer fix (SmartChunker.mergeOrDropNearEmptyChunks, same issue) stops NEW chunks like this
 * from being created; this migration is the one-time sweep for what earlier ingests already
 * persisted and vectorized. See nearEmptyChunkScan.ts for the full scan/plan predicate shared with
 * the read-only preview, including why vectorless chunks are deliberately out of scope here.
 *
 * PER-FILE, INTERLEAVED, so a partial run converges. Every file's delete and its rollup repair
 * happen back-to-back, wrapped in its own try/catch - an interruption (a timeout on the 15-minute
 * deploy-gating migrator Lambda, infra/database.ts, a bad row) leaves every already-settled file
 * consistent; at most the one file being processed when the interruption hit can have its chunks
 * deleted with its rollup not yet repaired, and that file's rollup self-corrects the next time
 * anything measures it from source (a later repair pass, a rebuild-passages wave, the live
 * vectorize handler). A re-run picks up wherever the scan still finds candidates rather than
 * redoing settled files.
 *
 * ROLLUP REPAIR IS FROM SOURCE, NEVER A BLIND `$inc`. `chunkCount` (a fresh count),
 * `chunkedCharCount`/`maxChunkCharLength`/`embeddedChunkCount`/`embeddedCharCount` (from
 * `computeFileChunkRollups`, the same aggregate the char-length backfill trusts) are recomputed
 * from the post-delete chunk set and `$set`, not decremented - a decrement assumes the stored
 * value was a well-formed number, and it is not always one: `resetChunkStateByIds` explicitly nulls
 * several of these fields, and none of `chunkedCharCount`/`maxChunkCharLength`/
 * `embeddedChunkCount`/`embeddedCharCount` has a schema default, so a raw `$inc` on a legacy or
 * mid-reset file either THROWS (nulling a field errors "$inc a value of non-numeric type", which
 * would abort this whole migration and the deploy behind it) or silently CREATES a negative value
 * on an absent one - which `isMemberIndexingInFlight` reads as permanently still-indexing, exactly
 * the outage class the rollup counters exist to prevent. If any of a file's SIX rollup fields is
 * not already a number, this migration leaves that file's rollups untouched (still correctly
 * "unmeasured") rather than guess at them - whatever eventually measures it (the char-length
 * backfill, a rebuild-passages wave, the live vectorize handler) will read the corrected,
 * already-swept chunk set.
 *
 * `vectorizedChunkCount` is the one field that cannot be recomputed from source here (that needs
 * the file's embedding-model context window, to tell a genuinely oversized-and-unembeddable chunk
 * from a vector-bearing one - a value this migration does not have and should not guess). Every row
 * this migration deletes is vector-bearing (the scan's own predicate) and this migration never
 * touches an OVERSIZED chunk, so the oversized-and-vectorless share of "terminal" is unchanged by
 * the delete, and `vectorizedChunkCount` is safe to decrement by exactly how many rows were
 * actually deleted for that file (`deleteMany`'s own `deletedCount`, not a stale pre-delete plan
 * count - the two can differ if something else touched the file's chunks in between). That
 * decrement is applied with an optimistic-concurrency guard (the update's filter re-checks
 * `vectorizedChunkCount` still equals what was just read): if the LIVE vectorize handler
 * (apps/client/server/queueHandlers/fabFileVectorize.ts) touches the same file in that same
 * instant, the guard fails and this migration skips the write rather than clobbering it - safe to
 * skip, because that handler recomputes `vectorizedChunkCount`/`embeddedChunkCount`/
 * `embeddedCharCount` from source on its own next write, which by then already reflects this
 * migration's completed delete.
 *
 * OUT OF SCOPE: self-host OpenSearch. On a self-host stage a deleted chunk's vector may still live
 * in the retrieval index (`FabFileChunkSearchIndex`) until reindexed, since that store keeps its
 * own copy outside Mongo - low exposure in practice, since self-host deployments do not run this
 * migrate tooling today (see SELF_HOST.md), but noted rather than silently assumed handled.
 *
 * To see the counts before acting, run the READ-ONLY preview against the target stage (needs the
 * stage's linked MONGODB_URI, so it runs inside `sst shell`):
 *   ./for-env <env> pnpm sst shell --stage <stage> -- pnpm --filter scripts db:preview-near-empty-chunks
 * No dry-run flag on the migration itself, same reasoning as
 * 20260911120000_delete-unaddressable-fabfilechunks: the runner's ledger write happens as soon as
 * `up()` resolves, so a flag that returned normally would permanently foreclose the real pass.
 *
 * NOT REVERSIBLE. `down()` is a no-op - the deleted rows are gone, and a rollup repair, being
 * computed from source at repair time, is not something a later `down()` could sensibly undo.
 */

/** Ids logged per bucket in a warning, so a large finding does not bury the summary. */
const LOG_ID_CAP = 50;

/** Chunk ids deleted per batch within one file's delete, bounding any single `deleteMany`. */
const DELETE_BATCH_SIZE = 500;

/** Files processed between progress lines. A timeout mid-run is otherwise undiagnosable. */
const PROGRESS_EVERY_FILES = 100;

const capped = (ids: string[]) =>
  ids.length <= LOG_ID_CAP
    ? ids.join(', ')
    : `${ids.slice(0, LOG_ID_CAP).join(', ')} ... and ${ids.length - LOG_ID_CAP} more (capped at ${LOG_ID_CAP})`;

/**
 * Deletes one file's candidate rows (batched) and repairs its rollup from source. Never throws -
 * a bad row for one file must not abandon every file after it; the caller logs what this returns.
 */
async function processFilePlan(plan: NearEmptyChunkFilePlan): Promise<{
  deleted: number;
  keptSoleChunk: boolean;
  rollup: 'repaired' | 'skipped-unmeasured' | 'skipped-invalid-id' | 'skipped-concurrent' | 'error';
}> {
  const { fabFileId, deletableIds, keptSoleChunkId } = plan;
  const chunks = FabFileChunk.collection;

  let deleted = 0;
  for (let i = 0; i < deletableIds.length; i += DELETE_BATCH_SIZE) {
    const batch = deletableIds.slice(i, i + DELETE_BATCH_SIZE);
    deleted += (await chunks.deleteMany({ _id: { $in: batch } })).deletedCount;
  }

  if (!mongoose.isObjectIdOrHexString(fabFileId)) {
    // Known-dirty rows survive the sibling unaddressable-chunk sweep by design (a value that
    // still embeds a resolvable file id is kept for manual review) - a non-hex fabFileId here
    // would throw on ObjectId construction. The chunk rows are still gone; only the parent
    // file's rollup is left unrepaired.
    return { deleted, keptSoleChunk: !!keptSoleChunkId, rollup: 'skipped-invalid-id' };
  }

  const _id = new mongoose.Types.ObjectId(fabFileId);
  try {
    const current = await FabFile.collection.findOne(
      { _id },
      {
        projection: {
          chunkCount: 1,
          chunkedCharCount: 1,
          maxChunkCharLength: 1,
          vectorizedChunkCount: 1,
          embeddedChunkCount: 1,
          embeddedCharCount: 1,
        },
      }
    );
    if (!current) return { deleted, keptSoleChunk: !!keptSoleChunkId, rollup: 'skipped-unmeasured' };

    const rollupFields = [
      current.chunkCount,
      current.chunkedCharCount,
      current.maxChunkCharLength,
      current.vectorizedChunkCount,
      current.embeddedChunkCount,
      current.embeddedCharCount,
    ];
    if (!rollupFields.every(v => typeof v === 'number')) {
      // At least one rollup field is null/absent (unmeasured - see the docblock). Leave it that
      // way rather than $inc a value that isn't there.
      return { deleted, keptSoleChunk: !!keptSoleChunkId, rollup: 'skipped-unmeasured' };
    }

    const [chunkCount, sourceRollup] = await Promise.all([
      chunks.countDocuments({ fabFileId }, { maxTimeMS: 120_000 }),
      fabFileChunkRepository.computeFileChunkRollups(fabFileId),
    ]);
    const vectorizedChunkCount = Math.max(0, current.vectorizedChunkCount - deleted);

    const result = await FabFile.collection.updateOne(
      { _id, vectorizedChunkCount: current.vectorizedChunkCount },
      {
        $set: {
          chunkCount,
          chunkedCharCount: sourceRollup.chunkedCharCount,
          maxChunkCharLength: sourceRollup.maxChunkCharLength,
          embeddedChunkCount: sourceRollup.embeddedChunkCount,
          embeddedCharCount: sourceRollup.embeddedCharCount,
          vectorizedChunkCount,
        },
      }
    );
    if (result.matchedCount === 0) {
      // The live vectorize handler touched this file's vectorizedChunkCount between our read and
      // write - safe to skip; that handler recomputes from source on its own next write, which by
      // then already reflects this delete.
      return { deleted, keptSoleChunk: !!keptSoleChunkId, rollup: 'skipped-concurrent' };
    }
    return { deleted, keptSoleChunk: !!keptSoleChunkId, rollup: 'repaired' };
  } catch (error) {
    console.warn(`Rollup repair failed for FabFile ${fabFileId} (chunks already deleted): ${String(error)}`);
    return { deleted, keptSoleChunk: !!keptSoleChunkId, rollup: 'error' };
  }
}

const migration: MigrationFile = {
  id: 20260915120000,
  name: 'delete-near-empty-vectorized-fabfilechunks',

  up: async () => {
    const { candidatesByFile, scanned, pages } = await collectNearEmptyCandidates(info => {
      if (info.pages % 25 === 0) {
        console.log(`  ... scanned ${info.scanned} near-empty vector-bearing row(s), through _id ${info.lastId}`);
      }
    });
    console.log(`Scanned ${scanned} near-empty vector-bearing row(s) across ${candidatesByFile.size} file(s).`);
    if (pages > 1) console.log(`  (${pages} scan pages)`);

    const plans = await planNearEmptyChunkDeletions(candidatesByFile);

    let totalDeleted = 0;
    let filesProcessed = 0;
    const keptSoleChunkFiles: string[] = [];
    const skippedInvalidIdFiles: string[] = [];
    const skippedUnmeasuredFiles: string[] = [];
    const skippedConcurrentFiles: string[] = [];
    const erroredFiles: string[] = [];

    for (const plan of plans) {
      const outcome = await processFilePlan(plan);
      totalDeleted += outcome.deleted;
      filesProcessed += 1;
      if (outcome.keptSoleChunk) keptSoleChunkFiles.push(plan.fabFileId);
      if (outcome.rollup === 'skipped-invalid-id') skippedInvalidIdFiles.push(plan.fabFileId);
      if (outcome.rollup === 'skipped-unmeasured') skippedUnmeasuredFiles.push(plan.fabFileId);
      if (outcome.rollup === 'skipped-concurrent') skippedConcurrentFiles.push(plan.fabFileId);
      if (outcome.rollup === 'error') erroredFiles.push(plan.fabFileId);

      if (filesProcessed % PROGRESS_EVERY_FILES === 0) {
        console.log(
          `  ... repaired ${filesProcessed} of ${plans.length} file(s), ${totalDeleted} row(s) deleted so far`
        );
      }
    }

    console.log(
      `Deleted ${totalDeleted} near-empty vector-bearing fabfilechunk row(s) across ${plans.length} file(s).`
    );
    if (keptSoleChunkFiles.length > 0) {
      console.warn(
        `${keptSoleChunkFiles.length} file(s) had every chunk under the floor - kept the least-degenerate one rather than leave chunkCount at 0.`
      );
      console.warn(`   fabFile ids: ${capped(keptSoleChunkFiles)}`);
    }
    if (skippedInvalidIdFiles.length > 0) {
      console.warn(
        `${skippedInvalidIdFiles.length} file(s) had a non-ObjectId fabFileId - chunks deleted, rollup left unrepaired.`
      );
      console.warn(`   fabFile ids: ${capped(skippedInvalidIdFiles)}`);
    }
    if (skippedUnmeasuredFiles.length > 0) {
      console.log(`${skippedUnmeasuredFiles.length} file(s) had an unmeasured rollup already - left as unmeasured.`);
    }
    if (skippedConcurrentFiles.length > 0) {
      console.log(
        `${skippedConcurrentFiles.length} file(s) were concurrently touched by the live vectorize handler - rollup left to it.`
      );
    }
    if (erroredFiles.length > 0) {
      console.warn(
        `${erroredFiles.length} file(s) had chunks deleted but their rollup repair threw - see warnings above.`
      );
      console.warn(`   fabFile ids: ${capped(erroredFiles)}`);
    }
  },

  down: async () => {
    // Deleted rows are not reconstructable, and a rollup repair computed from source at repair
    // time is not something a later down() could sensibly undo. See the docblock.
  },
};

export default migration;
