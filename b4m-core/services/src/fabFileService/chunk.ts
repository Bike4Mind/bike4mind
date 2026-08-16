import {
  ChunkClaimLostError,
  countCodePoints,
  IFabFileChunkDocument,
  IFabFileRepository,
  IUserDocument,
  SupportedEmbeddingModelSchema,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { NotFoundError, secureParameters, SmartChunker } from '@bike4mind/utils';
import { z } from 'zod';

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

export const chunkFabfile = async (
  user: IUserDocument,
  parameters: ChunkFileParameters,
  { db, storage, logger, searchIndex }: ChunkFileAdapters
) => {
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

  // Resolved before the old chunks are deleted below - their per-chunk embeddingModel is the
  // only place this survives once they're gone. Chunks can span more than one model if this
  // file was already re-embedded once before (see IFabFileChunk.embeddingModel), so
  // fabFile.embeddingModel alone - the CURRENT model only - would miss an earlier OpenSearch
  // index left behind by that prior re-embed.
  const previousChunkEmbeddingModels = searchIndex
    ? await db.fabFileChunks.distinctEmbeddingModelsByFabFileIds([fabFileId])
    : [];

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
  // filter never matches against stale data. Skipped entirely when no stamp was supplied (see
  // chunkFileSchema) - never the case for the real production caller.
  if (chunkClaimedAt !== undefined && !(await db.fabFiles.confirmChunkClaim(fabFileId, chunkClaimedAt))) {
    throw new ChunkClaimLostError(fabFileId);
  }

  const chunked = chunks.length > 0;

  // Explicit payload naming only the fields this function owns (#1802): `isChunking` and
  // `chunkClaimedAt` are the WORKER's claim, acquired by its CAS and released in its `finally`
  // (fabFileChunk.ts). Passing the whole loaded `fabFile` through `update()` - a `$set` of every
  // key - would rewrite both mid-run, which is the entire mechanism #1802 reports. Naming the
  // fields here means a future field added to FabFile is excluded by default, not by omission.
  await db.fabFiles.update({
    id: fabFile.id,
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
  });

  await db.fabFileChunks.deleteManyByFabFileId(fabFileId);
  if (searchIndex) {
    await Promise.all(previousChunkEmbeddingModels.map(model => searchIndex.deleteByFabFileId(fabFileId, model)));
  }

  const fabFileChunks = await Promise.all(
    chunks.map(async (chunk, i) => {
      return {
        ...chunk,
        charLength: chunkCharLengths[i],
        fabFileId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    })
  );

  const result = await db.fabFileChunks.bulkInsert(fabFileChunks);

  return result;
};
