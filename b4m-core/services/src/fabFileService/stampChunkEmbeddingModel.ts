import { IFabFileRepository } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import type { Logger } from '@bike4mind/observability';

interface StampChunkEmbeddingModelAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'update'>;
    fabFileChunks: {
      updateEmbeddingModel: (fabFileId: string, embeddingModel: string) => Promise<void>;
      distinctEmbeddingModelsByFabFileId: (fabFileId: string) => Promise<string[]>;
    };
  };
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Label a file's chunks with the model its vectors were generated under, then record when the stamp
 * completed. Called once a file's WHOLE chunk batch has committed (not per-chunk) - the readiness
 * stamp it writes is what tells the Atlas cutover the file is ready to query.
 *
 * Only fills chunks that carry NO label: the vectorize handler labels each chunk in the same
 * transaction that stores its vector, so a chunk's label always names the model that actually
 * produced the vector sitting beside it. See `updateEmbeddingModel` (packages/database) for the
 * mid-ingest credential change a blanket relabel used to hide.
 *
 * `stampFile` writes the FILE-level label too, and ONLY the vectorize handler passes it. That label
 * is exclusion AUTHORITY - `isForeignEmbeddingModel` drops a labeled file from every search wholesale
 * - so it may only be written by a caller that KNOWS which model it just embedded with. The
 * packages/scripts/datalake backfill does not: for a legacy file with no recorded label it GUESSES
 * from vector width and tiebreaks with the deployment default, and ten registered models share
 * 1024 dims. Left unlabeled, a wrong guess is harmless (a blank label is never foreign); promoted to
 * the file level it would drop a healthy file from search and tell the user to re-embed it.
 *
 * The file label is written HERE rather than at the requested model, because this is the first point
 * that knows which model the vectors were ACTUALLY generated under. chunkFabfile writes an initial
 * label from the deployment default, but the vectorize handler may resolve a different one
 * (resolveEmbeddingWithKeylessFallback: no provider credential -> keyless Bedrock). Leaving the file
 * on the requested label strands it: every retrieval reader excludes it at the FILE level as foreign
 * and never reaches its correctly-stamped chunks, so a successfully embedded file returns zero hits.
 *
 * A file whose chunks declare MORE than one model gets its file label CLEARED instead, with a warning.
 * Any single value would be a lie about half the vectors, and of the three options a blank label is
 * the only safe one: `isForeignEmbeddingModel` never excludes it, so each chunk is still matched on
 * its own truthful label by the Atlas filter, while the two deliberately-stricter readers (the corpus
 * defer gate and `isFabFileCitable`) treat blank as unreachable and simply decline to optimize. Both
 * directions cost performance, neither loses content.
 *
 * `chunkEmbeddingModelStampedAt` is the readiness signal the Atlas `$vectorSearch` cutover reads
 * (see atlasSearchIndex.ts / vectorSearchEligibility.ts) - it must be set AFTER the chunk stamp
 * commits, never before, or a reader could see "ready" while chunks are still unstamped.
 *
 * All writes run in one transaction: without it, a crash mid-way would leave the chunks correctly
 * stamped but the readiness stamp permanently unset - the vectorize handler's own idempotency
 * check already treats this file as done, so no later SQS redelivery would retry it.
 *
 * `fileUpdate` lets a caller fold its OWN fabFile write into this same transaction (e.g. the
 * vectorize handler's `vectorized: true` flip) instead of committing it in a separate write
 * beforehand - that ordering is exactly the gap above, just one level up: a crash between "mark
 * vectorized" and "stamp the model" leaves the same permanently-unretryable state.
 */
export const stampChunkEmbeddingModel = async (
  fabFileId: string,
  embeddingModel: string,
  { db, logger }: StampChunkEmbeddingModelAdapters,
  fileUpdate: {
    vectorized?: boolean;
    vectorizedChunkCount?: number;
    isVectorizing?: boolean;
    embeddedChunkCount?: number;
    embeddedCharCount?: number;
    /** Write the FILE-level `embeddingModel` label as well. Vectorize handler only - see above. */
    stampFile?: boolean;
  } = {}
): Promise<void> => {
  const { stampFile, ...fileFields } = fileUpdate;
  // Resolved BEFORE the transaction opens, for two reasons. MongoDB permits `distinct` inside a
  // transaction only on an unsharded collection, and `transactionAsyncLocalStorage` would attach
  // this session to it automatically - so running it inside would start throwing the day
  // fabfilechunks is sharded, in the one place that has no test against a real mongod. And it is
  // not needed inside: the only write between this read and the file write is the stamp below,
  // which can add exactly one value (`embeddingModel`) and remove none, so the post-stamp set is
  // this set unioned with it - which is what resolveFileLabel computes.
  const fileLabel = stampFile ? await resolveFileLabel(fabFileId, embeddingModel, { db, logger }) : undefined;
  await withTransaction(async () => {
    await db.fabFileChunks.updateEmbeddingModel(fabFileId, embeddingModel);
    await db.fabFiles.update({
      id: fabFileId,
      ...(stampFile ? { embeddingModel: fileLabel } : {}),
      chunkEmbeddingModelStampedAt: new Date(),
      ...fileFields,
    });
  });
};

/**
 * The one model this file's chunks all declare, or null when they declare several - see the
 * divergence paragraph above for why null rather than a pick.
 *
 * `embeddingModel` is unioned in rather than returned directly, because it is what the pending
 * stamp will write onto any still-unlabeled chunk. Returning it directly would let the caller's
 * model become the file label even when every existing chunk declares a DIFFERENT one - the exact
 * mislabel this function exists to prevent, just arrived at from the other side. Unioning is also
 * why the one-model answer is the declared value and not the argument: they are equal in every
 * ordinary ingest, and where they differ the chunks are the ones holding the vectors.
 */
const resolveFileLabel = async (
  fabFileId: string,
  embeddingModel: string,
  { db, logger }: StampChunkEmbeddingModelAdapters
): Promise<string | null> => {
  const declared = new Set(await db.fabFileChunks.distinctEmbeddingModelsByFabFileId(fabFileId));
  declared.add(embeddingModel);
  if (declared.size === 1) return [...declared][0];
  logger?.warn(
    `[embeddings] FabFile ${fabFileId} has chunks in ${declared.size} embedding spaces ` +
      `(${[...declared].join(', ')}); a credential almost certainly changed mid-ingest. Leaving the ` +
      `file label unset so no reader excludes it wholesale - re-embed the file to consolidate it.`
  );
  return null;
};
