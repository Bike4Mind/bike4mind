import { IFabFileRepository } from '@bike4mind/common';
import { withTransaction } from '@bike4mind/db-core';
import type { Logger } from '@bike4mind/observability';

interface StampChunkEmbeddingModelAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'update'>;
    fabFileChunks: {
      updateEmbeddingModel: (fabFileId: string, embeddingModel: string) => Promise<void>;
      distinctEmbeddingModelsByFabFileId: (fabFileId: string) => Promise<string[]>;
      countUnlabeledVectorChunksByFabFileId: (fabFileId: string) => Promise<number>;
    };
  };
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Label a file's chunks with the model its vectors were generated under, then record when the stamp
 * completed. Called once a file's WHOLE chunk batch has committed (not per-chunk) - the readiness
 * stamp it writes is what tells the Atlas cutover the file is ready to query.
 *
 * Only fills VECTOR-BEARING chunks that carry NO label: the vectorize handler labels each chunk in
 * the same transaction that stores its vector, so a chunk's label always names the model that
 * actually produced the vector sitting beside it, and a chunk with no vector names no space at all.
 * See `updateEmbeddingModel` (packages/database) for the mid-ingest credential change a blanket
 * relabel used to hide, and for the oversized chunks an unscoped one mislabeled.
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
 * A file whose chunks declare MORE than one model gets its file label CLEARED instead, with a
 * warning, and so does a file that reached completion with no vector-bearing chunks at all (see
 * `resolveFileLabel`). Any single value would be a lie about half the vectors - or about all of
 * them - and of the three options a blank label is the least bad: `isForeignEmbeddingModel` never
 * excludes it, so each chunk is still matched on its own truthful label by the Atlas filter, while
 * the two deliberately-stricter readers (the corpus defer gate and `isFabFileCitable`) treat blank
 * as unreachable and decline to optimize.
 *
 * Least bad is not free, and two readers turn a blank FILE label into content the user never sees.
 * `lakeSourceReachability` requires an exact file-label match, so a blank one makes every source doc
 * unreachable and `recallLakeMemory` drops the beliefs citing them - silently, returning nothing at
 * all. And the attachment scan in llm/utils keys its query vector off the file label defaulted to
 * ada-002, so on any other deployment default that lookup misses, the whole cosine arm is skipped,
 * and a format the raw-content fallback cannot decode reaches the model as nothing. Both are
 * degradations a WRONG label makes worse rather than better - that one excludes the file from every
 * search at once and sends the operator to re-embed a healthy one - which is why blank is still the
 * answer here. Consolidating the file by re-embedding it is the actual repair, and that is what the
 * warning says.
 *
 * The retrieval arms themselves do match each chunk on its OWN label rather than the file's: the
 * Atlas arm through its `filter` clause, the in-process cosine arm through `classifyLoadedChunk`.
 * Width is no substitute for either - voyage-3 and Titan v2 are both 1024 wide, so a blank file
 * label with no chunk-level check left a split file's two halves scoring against each other as
 * though they shared a space.
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
  // not needed inside: the only write between these reads and the file write is the stamp below,
  // which can add exactly one value (`embeddingModel`), to exactly the rows the unlabeled count
  // identifies, and remove none - which is what resolveFileLabel computes.
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
 * The one model this file's VECTORS are all in, or null when they span several - see the divergence
 * paragraph above for why null rather than a pick.
 *
 * Null also when the file holds no vectors AT ALL, and that case is the reason this cannot simply
 * return `embeddingModel`. `embeddingModel` is what the CALLER resolved, which is evidence about
 * the vectors this message wrote and about nothing else - and a message can reach file completion
 * having written none: every chunk over the model's context window is skipped at embed time yet
 * still counts as terminal in the rollup, so an all-oversized file completes with an empty batch.
 * Labeling it from the argument there stamps a file whose every chunk is vectorless with a
 * confident space, which is exclusion authority derived from nothing, and it overwrites a truthful
 * blank label to do it.
 *
 * "No vectors at all" is NOT the same as an empty DECLARED set, which is why the unlabeled count is
 * read beside it. The distinct query only sees chunks that already carry a label, so it comes back
 * empty both for a file with nothing embedded and for one whose vectors are merely unlabeled so far
 * - a legacy file, or the chunk-model backfill's whole input. Those want opposite answers, and
 * reading the empty set alone gave them the same one: a truthful label withheld from a healthy file,
 * plus a warning telling the operator to re-upload it.
 *
 * The count also decides whether `embeddingModel` joins the set at all. It is unioned in because it
 * is what the pending stamp will write onto any still-unlabeled vector-bearing chunk - so where
 * there is no such chunk the stamp writes nothing, and the argument is then evidence about no vector
 * in this file. Unioning it anyway invents a second space out of a message that embedded nothing,
 * and a second entry clears the label: a file whose vectors are uniformly voyage-3 would lose its
 * label to a later pass that had only oversized chunks to show for itself.
 *
 * When the set is non-empty, `embeddingModel` is unioned rather than returned directly, because
 * returning it would let the caller's model become the file label even when every existing chunk
 * declares a DIFFERENT one - the same mislabel arrived at from the other side.
 *
 * A one-model set still only becomes the file label when that model is THIS message's own, which is
 * why the label returned here is always either `embeddingModel` or null. A chunk label is only as
 * good as whatever wrote it, and not every writer observed an embedding: the chunk-model backfill
 * guesses a legacy file's model from vector WIDTH, which cannot separate the ten registered models
 * sharing 1024 dims. Promoting a guess is the move the opening paragraph rules out - a blank file
 * label costs a retrieval degradation, a wrong one excludes the whole file and tells the operator to
 * re-embed a healthy one.
 *
 * The match is a HEURISTIC, and only one direction of it holds. A mismatch does prove this message
 * wrote none of these vectors, so withholding the label is sound. The converse does not follow:
 * equality does not show this message wrote anything, and the backfill population is exactly where
 * it fails - the width guess tiebreaks to the deployment default, which on a keyless cloud stage
 * resolves to the same model resolveEmbeddingWithKeylessFallback hands this pass, so the two agree
 * by construction rather than by evidence. Separating "labeled by the vectorize transaction" from
 * "labeled by the width backfill" needs a provenance marker the chunk rows do not carry; until one
 * exists this guard closes the immediate mismatch and leaves that population uncovered.
 *
 * The unlabeled count is no substitute for such a marker: a multi-message fan-out whose last message
 * is entirely oversized legitimately arrives here with one declared model and nothing unlabeled,
 * every label written by this ingest, and gating on it would withhold a truthful label there.
 *
 * Vectors this message did not write are evidence about the chunks, never about the file.
 */
const resolveFileLabel = async (
  fabFileId: string,
  embeddingModel: string,
  { db, logger }: StampChunkEmbeddingModelAdapters
): Promise<string | null> => {
  const [declaredModels, unlabeledVectorChunks] = await Promise.all([
    db.fabFileChunks.distinctEmbeddingModelsByFabFileId(fabFileId),
    db.fabFileChunks.countUnlabeledVectorChunksByFabFileId(fabFileId),
  ]);
  const declared = new Set(declaredModels);
  if (unlabeledVectorChunks > 0) declared.add(embeddingModel);
  if (declared.size === 0) {
    logger?.warn(
      `[embeddings] FabFile ${fabFileId} reached completion with no vector-bearing chunks; leaving ` +
        `the file label unset rather than stamping ${embeddingModel}, which embedded none of them. ` +
        `Every chunk was most likely skipped as oversized - re-upload the file to re-chunk it.`
    );
    return null;
  }
  if (declared.size === 1) {
    const [only] = [...declared];
    if (only === embeddingModel) return only;
    logger?.warn(
      `[embeddings] FabFile ${fabFileId} holds only vectors this message did not write, all ` +
        `declaring ${only} while this message resolved ${embeddingModel}. Leaving the file label ` +
        `unset: a chunk label is only as good as whatever wrote it, and promoting a wrong one would ` +
        `drop the whole file from every search, where a blank label only degrades retrieval. ` +
        `Re-embed the file to consolidate it.`
    );
    return null;
  }
  logger?.warn(
    `[embeddings] FabFile ${fabFileId} has chunks in ${declared.size} embedding spaces ` +
      `(${[...declared].join(', ')}); a credential almost certainly changed mid-ingest. Leaving the ` +
      `file label unset so no reader excludes it wholesale - re-embed the file to consolidate it.`
  );
  return null;
};
