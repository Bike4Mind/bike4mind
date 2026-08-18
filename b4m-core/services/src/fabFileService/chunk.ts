import {
  ChunkClaimLostError,
  countCodePoints,
  IFabFileChunkDocument,
  IFabFileRepository,
  IUserDocument,
  SupportedEmbeddingModelSchema,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters, SmartChunker, type Chunk } from '@bike4mind/utils';
import { z } from 'zod';
import { computeServerTextHash } from '../dataLakeService/admissionContract';

const chunkFileSchema = z.object({
  fabFileId: z.string(),
  // Enum-constrained, not a bare string: this function is the ONLY writer of
  // FabFile.embeddingModel (below), and several readers compare that stored label to the query's
  // as an exact string, so a mis-cased or unrecognized value reads as positively FOREIGN rather
  // than unknown - dropping a correctly-embedded file from retrieval and telling the user to
  // re-embed it. See isForeignEmbeddingModel (dataLakeService/embeddingMismatch.ts) for the
  // canonical list of those readers and why the match is not case-folded. The sole caller already
  // guards with isSupportedEmbeddingModel (queueHandlers/fabFileChunk.ts), so this rejects nothing
  // sent today - it stops a future writer persisting a label the readers cannot match.
  embeddingModel: SupportedEmbeddingModelSchema,
  // Soft chunk-size cap in tokens (see DEFAULT_PASSAGE_TOKEN_TARGET). Optional: the
  // chunker's passage-granularity default applies when omitted.
  passageTokenTarget: z.number().int().positive().optional(),
  // The worker's claim stamp (#1802 Phase 2): the exact `chunkClaimedAt` its CAS acquired with.
  // Optional - so a caller written before this existed (or any hypothetical caller with no claim
  // to hold) is unaffected; the guarded ownership check below only runs when a stamp is actually
  // supplied. The sole production caller (fabFileChunk.ts) always has one by the time it calls
  // this, so the check is live on every real run - omitting it is a compatibility no-op, never a
  // way to bypass the check on a path that genuinely holds a claim.
  chunkClaimedAt: z.date().optional(),
});

/**
 * `embeddingModel` is deliberately kept as `string` here rather than inheriting the schema's
 * narrowed `SupportedEmbeddingModel`. `chunkFabfile` is exported from the published
 * `@bike4mind/services`, so narrowing an argument type would be a breaking change for any external
 * caller holding a plain `string` - the same reason the chunk-stamp seams in `@bike4mind/common`
 * were left alone. The enum is still enforced, at runtime, by `secureParameters` below; a wide input
 * type is exactly the case that guard exists for, and narrowing it here would invite a reader to
 * assume the runtime check is redundant.
 */
type ChunkFileParameters = Omit<z.infer<typeof chunkFileSchema>, 'embeddingModel'> & {
  embeddingModel: string;
};

interface ChunkFileAdapters {
  db: {
    fabFiles: IFabFileRepository;
    fabFileChunks: {
      deleteManyByFabFileId: (fabFileId: string) => Promise<void>;
      bulkInsert: (chunks: Omit<IFabFileChunkDocument, 'id'>[]) => Promise<IFabFileChunkDocument[]>;
      update: (chunk: IFabFileChunkDocument) => Promise<unknown>;
      distinctEmbeddingModelsByFabFileIds: (fabFileIds: string[]) => Promise<string[]>;
    };
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
  };
  storage: {
    getContentAsBuffer: (filePath: string) => Promise<Buffer>;
  };
  logger: Logger;
  /**
   * Self-host OpenSearch only (undefined elsewhere). Re-chunking deletes the old
   * FabFileChunk rows and their embeddingModel with them - without this, the old chunks'
   * OpenSearch vectors would survive as permanent orphans in the OLD model's index.
   */
  searchIndex?: { deleteByFabFileId: (fabFileId: string, embeddingModel: string) => Promise<void> };
}

/**
 * Everything `commitFabFileChunks` needs, produced by `prepareFabFileChunks` with no writes of its
 * own. Opaque to callers: build it with `prepareFabFileChunks`, hand it back unmodified.
 */
export interface PreparedFabFileChunks {
  fabFileId: string;
  embeddingModel: string;
  chunkClaimedAt?: Date;
  chunks: Chunk[];
  chunkCharLengths: number[];
  /** Distinct embedding models the OLD chunks carried; only populated when a searchIndex is wired. */
  previousChunkEmbeddingModels: string[];
  /** `null` (not `undefined`) when the file has no extractable text - see the write below. */
  serverTextHash: string | null;
}

/**
 * Phase 1 of chunking: read the file, fetch it from storage, tokenize it, and compute every value
 * the write needs. Performs NO writes, so it MUST run OUTSIDE the caller's Mongo transaction.
 *
 * The split exists because this phase is the slow one - an S3 download plus full tokenization of a
 * document that can run to tens of thousands of chunks - and running it inside `withTransaction`
 * put it under the transaction lifetime: a member too large to finish aborts with a code
 * `isTransientTransactionError` classifies as retryable, so the whole download-and-tokenize is
 * redone up to `maxRetries` more times before failing deterministically. That was rare while
 * re-chunking was a user-triggered one-file-at-a-time operation; owner-triggered convergence
 * (#1681) turns it into a sweep that targets the LARGEST documents first, which is exactly the
 * population that hits it. With the split, a transient write conflict retries the write alone.
 */
export const prepareFabFileChunks = async (
  user: IUserDocument,
  parameters: ChunkFileParameters,
  { db, storage, logger, searchIndex }: ChunkFileAdapters
): Promise<PreparedFabFileChunks> => {
  const { fabFileId, embeddingModel, passageTokenTarget, chunkClaimedAt } = secureParameters(
    parameters,
    chunkFileSchema
  );

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, fabFileId);
  if (!fabFile) throw new NotFoundError('FabFile not found');

  logger.updateMetadata({ mimeType: fabFile.mimeType });

  const chunker = new SmartChunker(embeddingModel, storage, logger, { passageTokenTarget });
  const chunks = await chunker.chunkFile(fabFile);
  chunker.freeEncoder();
  Logger.globalInstance.log(`Completed chunking file into ${chunks.length} chunks`);

  const chunkCharLengths = chunks.map(chunk => countCodePoints(chunk.text));

  // Resolved before the old chunks are deleted in the commit phase - their per-chunk embeddingModel
  // is the only place this survives once they're gone. Chunks can span more than one model if this
  // file was already re-embedded once before (see IFabFileChunk.embeddingModel), so
  // fabFile.embeddingModel alone - the CURRENT model only - would miss an earlier OpenSearch
  // index left behind by that prior re-embed.
  const previousChunkEmbeddingModels = searchIndex
    ? await db.fabFileChunks.distinctEmbeddingModelsByFabFileIds([fabFileId])
    : [];

  // Lake admission contract (#1679): fingerprint the CANONICAL EXTRACTED TEXT (chunker.getExtractedText()),
  // NOT the chunk output - whose boundaries, envelopes, and redaction move with chunk policy, so two
  // byte-identical files under different owner policies would fingerprint differently. computeServerTextHash
  // returns undefined for a file with no extractable text (nothing to dedup on) rather than hashing the
  // empty string, which would collide across every such file; persist that as an explicit null so the
  // field is ALWAYS written in the payload below. Skipping the write on a text-less re-chunk (e.g. a
  // reprocess dropping N chunks to 0) would leave the prior chunking's stale hash in place and let the
  // fingerprint outlive its text. See dataLakeService/admissionContract.ts for why this is the
  // trustworthy dedup input, not contentHash.
  const serverTextHash = computeServerTextHash(chunker.getExtractedText()) ?? null;

  return {
    fabFileId: fabFile.id,
    embeddingModel,
    chunkClaimedAt,
    chunks,
    chunkCharLengths,
    previousChunkEmbeddingModels,
    serverTextHash,
  };
};

/**
 * Phase 2 of chunking: every write, and nothing else. Intended to run INSIDE the caller's
 * transaction, so the rollup update, the delete and the reinsert commit together. Cheap to retry -
 * that is the point of the split (see `prepareFabFileChunks`).
 */
export const commitFabFileChunks = async (
  prepared: PreparedFabFileChunks,
  { db, logger, searchIndex }: Pick<ChunkFileAdapters, 'db' | 'logger' | 'searchIndex'>
): Promise<IFabFileChunkDocument[]> => {
  const { fabFileId, embeddingModel, chunkClaimedAt, chunks, chunkCharLengths, previousChunkEmbeddingModels } =
    prepared;

  // Guarded-write ownership check (#1802 Phase 2), BEFORE any write this run makes - not just
  // before the destructive delete below. A superseded run that skipped this and still wrote its
  // rollup fields (chunked, chunkCount, embeddingModel, ...) would leave the FabFile document
  // describing chunks that were never actually deleted/replaced, an inconsistent state even
  // without reaching the destructive section. A WRITE, not a read: a read's correctness would
  // depend on isolation semantics `withTransaction` never configures (no read concern is set -
  // db-core/src/utils/mongo.ts), while the competing CAS that could have taken this claim over
  // commits OUTSIDE any transaction. A matched write engages write-conflict detection instead -
  // verified sound on both engines, though by different mechanisms: MongoDB's WiredTiger raises a
  // transient WriteConflict (code 112) if the takeover landed inside this run's own snapshot window,
  // which `withTransaction` retries and the guard then correctly fails on; DocumentDB instead uses
  // real document-level write LOCKS (1-minute max hold, non-configurable), so a competing writer
  // blocks rather than racing and this write only ever sees fully-committed state. Either way, this
  // filter never matches against stale data - PROVIDED the write is genuinely a write. A bare
  // self-valued $set (writing chunkClaimedAt back to itself) was verified, against a real replica
  // set, to be silently elidable: MongoDB can treat it as a no-op and let the match succeed against
  // a stale snapshot with no conflict ever raised. confirmChunkClaim's write also stamps
  // chunkClaimConfirmedAt for exactly this reason - see its doc comment - so this guarantee does not
  // quietly depend on FabFile's schema happening to have `timestamps: true`. A retried WriteConflict
  // here re-runs THIS function only: the S3 download and tokenization happened in
  // `prepareFabFileChunks`, outside the transaction, and are not repeated. Skipped entirely when no
  // stamp was supplied (see chunkFileSchema) - never the case for the real production caller, logged
  // below if it ever is.
  if (chunkClaimedAt === undefined) {
    logger.warn(`chunkFabfile called for ${fabFileId} with no claim stamp - guarded-write ownership check skipped`);
  } else if (!(await db.fabFiles.confirmChunkClaim(fabFileId, chunkClaimedAt))) {
    throw new ChunkClaimLostError(fabFileId);
  }

  const chunked = chunks.length > 0;

  // Explicit payload naming only the fields this function owns (#1802): `isChunking` and
  // `chunkClaimedAt` are the WORKER's claim, acquired by its CAS and released in its `finally`
  // (fabFileChunk.ts). Passing the whole loaded `fabFile` through `update()` - a `$set` of every
  // key - would rewrite both mid-run, which is the entire mechanism #1802 reports. Naming the
  // fields here means a future field added to FabFile is excluded by default, not by omission.
  await db.fabFiles.update({
    id: fabFileId,
    chunked,
    chunkCount: chunks.length,
    chunkedCharCount: chunkCharLengths.reduce((sum, len) => sum + len, 0),
    // Lake-health P1 rollup (#1666): the largest chunk, so health checks "no chunk exceeds the
    // policy size" without rescanning the chunk collection. 0 for a file that produced no chunks.
    // `reduce`, not `Math.max(...spread)`: a file can carry tens of thousands of chunks and the
    // spread would risk a call-stack RangeError - and it matches the sum just above.
    maxChunkCharLength: chunkCharLengths.reduce((max, len) => (len > max ? len : max), 0),

    isVectorizing: false,
    vectorized: chunked,
    // Re-chunking replaces every chunk, so the vector-bearing rollups from the OLD chunks are now
    // stale. Zero them here; the vectorize pass that follows re-stamps them from the new chunks.
    // Left in place, they would grade P3 / reachability against chunks that no longer exist.
    vectorizedChunkCount: 0,
    embeddedChunkCount: 0,
    embeddedCharCount: 0,

    embeddingModel,
    // The old chunks (and their embeddingModel stamps) are about to be deleted below - a stale
    // readiness timestamp would make the Atlas cutover read path treat this file as ANN-ready
    // before the new chunks are re-stamped, silently returning zero results (see
    // vectorSearchEligibility.ts).
    chunkEmbeddingModelStampedAt: null,

    // Always written - null when there is no extractable text - so a text-less re-chunk clears any
    // stale fingerprint rather than letting it outlive its text. See the computeServerTextHash note
    // in prepareFabFileChunks.
    serverTextHash: prepared.serverTextHash,
  });

  await db.fabFileChunks.deleteManyByFabFileId(fabFileId);
  if (searchIndex) {
    await Promise.all(previousChunkEmbeddingModels.map(model => searchIndex.deleteByFabFileId(fabFileId, model)));
  }

  const fabFileChunks = chunks.map((chunk, i) => ({
    ...chunk,
    charLength: chunkCharLengths[i],
    fabFileId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

  return db.fabFileChunks.bulkInsert(fabFileChunks);
};

/**
 * Re-chunk a file: tokenize it at the requested passage target, then replace its chunk rows and
 * rollups wholesale.
 *
 * Kept as the published single-call entry point (`@bike4mind/services`), but note it runs BOTH
 * phases in the caller's context. A caller that wraps this in a Mongo transaction puts the S3 fetch
 * and tokenization inside it; prefer `prepareFabFileChunks` + `commitFabFileChunks` and wrap only
 * the commit, which is what the production chunk worker does.
 */
export const chunkFabfile = async (
  user: IUserDocument,
  parameters: ChunkFileParameters,
  adapters: ChunkFileAdapters
): Promise<IFabFileChunkDocument[]> => {
  const prepared = await prepareFabFileChunks(user, parameters, adapters);
  return commitFabFileChunks(prepared, adapters);
};
