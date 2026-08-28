import {
  CONVERGENCE_PAUSED_CHUNK_NOTE,
  CONVERGENCE_PAUSED_NOTES,
  DATALAKE_TAG_PREFIX,
  DataLakeMembershipScope,
  FabFileChunkPolicyConflict,
  IFabFileChunkDocument,
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  IFabFileVersion,
  FabFileSourceType,
  KnowledgeType,
  REBUILD_PENDING_STALE_MS,
} from '@bike4mind/common';
import mongoose, { Model, Schema } from 'mongoose';
import { getAtlasIndexForModel, getAtlasIndexStatus as getAtlasIndexStatusForModel } from '@bike4mind/fab-pipeline';
import { convertId, convertIds, softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { addLowercaseField } from '../../utils/documentdb-compat';
import { ShareableDocumentRepository, ShareableDocumentSchema } from './SharableDocumentModel';
import { buildFabFileSearchQuery, buildOwnershipConditions, escapeRegex } from '../../queries/fabFileSearchQuery';
import {
  buildDataLakeMembershipFilter,
  buildDataLakeMembershipQuery,
  buildNoOtherLakeMetaTagFilter,
} from '../../queries/dataLakeLifecycleScope';

/**
 * "not a lake membership tag", derived from the one constant rather than spelled out, so a change
 * to the namespace cannot leave a counter behind. Both tag counters exclude it: a meta-tag is
 * membership, never content, so it must not appear in the tag tree or inflate a prefix's count.
 */
const NOT_META_TAG = { $not: new RegExp(`^${DATALAKE_TAG_PREFIX}`) };

/**
 * Trim, then drop prefixes that cannot be anchored into a meaningful regex. A blank entry
 * contributes an empty alternation, so `['acme:', '']` becomes `^(acme:|)` and matches every tag
 * name - one bad entry would return the caller's entire non-deleted tag cloud. An all-blank list
 * would likewise become `^()`.
 *
 * The rule is `normalizeTagPrefix`'s, applied here so a direct caller gets the same answer as the
 * lake-resolving ones: trim, and require the trailing colon. Trimming matters because a padded
 * `' acme:'` builds `^( acme:)` and matches nothing, so the lake reads as empty while its files
 * stay browsable. The colon matters because a bare `acme` would match `acmecorp:` tags - a
 * different lake's content.
 *
 * Deduplicated: two lakes may legitimately share a `fileTagPrefix` (it is unreserved for dynamic
 * lakes), and a repeat contributes nothing but a duplicated regex arm - which the counters below
 * pay for per query. `byPrefix` is keyed by prefix, so a repeat would only overwrite its own key.
 *
 * NOTE for `countDataLakeUniqueFilesByPrefix`: `byPrefix` is therefore keyed by the NORMALIZED
 * prefix, so a consumer indexing it with a raw stored value must normalize too.
 */
const usableTagPrefixes = (tagPrefixes: string[]): string[] => [
  ...new Set(tagPrefixes.map(p => p.trim()).filter(p => p.length > 0 && p.endsWith(':'))),
];

interface IFabFileChunkModel extends Model<IFabFileChunkDocument> {}

export interface IFabFileModel extends Model<IFabFileDocument> {}

export class FabFileChunkRepository extends BaseRepository<IFabFileChunkDocument> implements IFabFileChunkRepository {
  constructor(private fabFileChunkModel: IFabFileChunkModel) {
    super(fabFileChunkModel);
  }

  async deleteManyByFabFileId(fabFileId: string) {
    await this.fabFileChunkModel.deleteMany({ fabFileId });
  }

  async distinctRetrievalIndexModelsByFabFileIds(fabFileIds: string[]): Promise<string[]> {
    if (fabFileIds.length === 0) return [];
    // Both fields, not just the readiness stamp - see IFabFileChunk.retrievalIndexModel. Two
    // `distinct` calls rather than one aggregate so each still rides the { fabFileId: 1, _id: 1 }
    // compound index below for the filter half of the scan.
    const [indexed, stamped] = await Promise.all([
      this.fabFileChunkModel.distinct('retrievalIndexModel', {
        fabFileId: { $in: fabFileIds },
        retrievalIndexModel: { $ne: null },
      }),
      this.fabFileChunkModel.distinct('embeddingModel', {
        fabFileId: { $in: fabFileIds },
        embeddingModel: { $ne: null },
      }),
    ]);
    return [...new Set([...indexed, ...stamped])];
  }

  async retrievalIndexModelsByFabFileIds(fabFileIds: string[]): Promise<Record<string, string[]>> {
    if (fabFileIds.length === 0) return {};
    // Same fields as distinctRetrievalIndexModelsByFabFileIds, grouped instead of flattened.
    // `$addToSet` dedupes per file, matching `distinct`'s semantics within each group; it skips a
    // MISSING field but keeps an explicit null, hence the filter when the two sets are merged.
    const rows = await this.fabFileChunkModel.aggregate<{ _id: string; models: (string | null)[] }>([
      {
        $match: {
          fabFileId: { $in: fabFileIds },
          $or: [{ retrievalIndexModel: { $ne: null } }, { embeddingModel: { $ne: null } }],
        },
      },
      {
        $group: {
          _id: '$fabFileId',
          models: { $addToSet: '$retrievalIndexModel' },
          stampedModels: { $addToSet: '$embeddingModel' },
        },
      },
      { $project: { models: { $setUnion: ['$models', '$stampedModels'] } } },
    ]);
    const byFile: Record<string, string[]> = {};
    for (const row of rows) {
      const models = row.models.filter((model): model is string => typeof model === 'string');
      if (models.length > 0) byFile[String(row._id)] = models;
    }
    return byFile;
  }

  async bulkInsert(chunks: Omit<IFabFileChunkDocument, 'id'>[]) {
    const result = await this.fabFileChunkModel.insertMany(chunks);

    return result.map(d => d.toJSON());
  }

  async findByFabFileId(fabFileId: string) {
    return this.fabFileChunkModel.find({ fabFileId });
  }

  /**
   * One deterministic page of vector-bearing chunks for the given files, ascending by `_id`.
   * Vectorless chunks are filtered at the DB layer and only the fields semantic search needs
   * are projected; `.lean()` skips Mongoose hydration.
   *
   * `_id` is unique, so sorting on it is a TOTAL order and `_id > afterChunkId` is an exact
   * keyset cursor - no rows skipped or duplicated across pages regardless of the query plan.
   * That is what lets a caller walk a corpus larger than memory and still get a reproducible
   * result; the previous unsorted `.limit(cap)` returned an arbitrary slice instead.
   * Up to a couple hundred file ids the { fabFileId: 1, _id: 1 } index serves this as a
   * non-blocking SORT_MERGE across the $in. Past the planner's $in-explosion limit it cannot build
   * that plan and falls back to an _id range scan with a filter - a cap on the number of ids, not
   * on how much of the collection they cover; the `limit` keeps that bounded either way.
   */
  async findVectorsByFabFileIds(fabFileIds: string[], options: { limit?: number; afterChunkId?: string } = {}) {
    if (fabFileIds.length === 0) return [];
    const { limit = 10_000, afterChunkId } = options;
    const docs = await this.fabFileChunkModel
      .find({
        fabFileId: { $in: fabFileIds },
        vector: { $exists: true, $ne: [] },
        ...(afterChunkId ? { _id: { $gt: afterChunkId } } : {}),
      })
      .select({ _id: 1, fabFileId: 1, text: 1, vector: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => ({
      id: String(d._id),
      fabFileId: String(d.fabFileId),
      text: d.text ?? '',
      vector: (d.vector as number[]) ?? [],
    }));
  }

  /**
   * One deterministic page of chunk TEXT for a single file, ascending by `_id`.
   *
   * Deliberately separate from `findVectorsByFabFileIds`: that reader filters
   * `vector: { $exists: true, $ne: [] }`, which is right for cosine but would DROP a
   * vectorless chunk that still carries text. A text consumer needs every chunk,
   * vectorized or not, so reusing it here would silently lose content.
   *
   * Same keyset contract as the vector reader: `_id` is unique, so the order is total and
   * `afterChunkId` is an exact cursor - paging never skips or repeats a chunk.
   */
  async findTextsByFabFileId(fabFileId: string, options: { limit?: number; afterChunkId?: string } = {}) {
    const { limit = 1_000, afterChunkId } = options;
    const docs = await this.fabFileChunkModel
      .find({
        fabFileId,
        ...(afterChunkId ? { _id: { $gt: afterChunkId } } : {}),
      })
      .select({ _id: 1, text: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => ({ id: String(d._id), text: d.text ?? '' }));
  }

  /**
   * Every chunk of a file, vectorless ones included. Callers that page a bounded window
   * need this to tell "you are holding the whole file" from "you are holding a slice" -
   * counting only what a projected reader returned cannot make that distinction.
   */
  async countByFabFileId(fabFileId: string): Promise<number> {
    return this.fabFileChunkModel.countDocuments({ fabFileId });
  }

  async findUnderChunkedFabFileIds(fabFileIds: string[], tokenThreshold: number): Promise<string[]> {
    if (fabFileIds.length === 0) return [];
    // Match on tokenCount first so only oversized chunks feed the group; the { fabFileId: 1, _id: 1 }
    // index serves the id-set half. Worst-first ($sort on the max oversized chunk) so a bounded
    // rebuild wave repairs the least-retrievable files before the marginal ones.
    const rows = await this.fabFileChunkModel.aggregate<{ _id: string }>([
      { $match: { fabFileId: { $in: fabFileIds }, tokenCount: { $gt: tokenThreshold } } },
      { $group: { _id: '$fabFileId', maxTokenCount: { $max: '$tokenCount' } } },
      { $sort: { maxTokenCount: -1 } },
    ]);
    return rows.map(r => r._id);
  }

  /**
   * The file's vectorize rollup, computed in ONE pass over its chunks (the fetch is unavoidable -
   * `vector` is in no index - so it must not be paid twice per batch):
   *  - `terminalChunkCount`: chunks that have a vector OR are oversized past the model context window
   *    (permanently unembeddable). This is `vectorizedChunkCount`, recomputed from source so an SQS
   *    redelivery of a partial-batch message is idempotent (no `+=` double-counting).
   *  - `embeddedChunkCount` / `embeddedCharCount`: only chunks that TRULY carry a vector (lake-health
   *    P3, #1666), where an oversized-unembeddable chunk counts toward terminal but NOT here.
   * Scoped to one file at vectorize completion, on the {fabFileId,_id} index - not a lake-wide scan.
   */
  async computeChunkVectorRollup(
    fabFileId: string,
    contextWindow: number
  ): Promise<{ terminalChunkCount: number; embeddedChunkCount: number; embeddedCharCount: number }> {
    const hasVector = { $gt: [{ $size: { $ifNull: ['$vector', []] } }, 0] };
    const isTerminal = { $or: [hasVector, { $gt: ['$tokenCount', contextWindow] }] };
    const charLen = { $ifNull: ['$charLength', 0] };
    const [agg] = await this.fabFileChunkModel.aggregate<{
      terminalChunkCount: number;
      embeddedChunkCount: number;
      embeddedCharCount: number;
    }>([
      { $match: { fabFileId } },
      {
        $group: {
          _id: null,
          terminalChunkCount: { $sum: { $cond: [isTerminal, 1, 0] } },
          embeddedChunkCount: { $sum: { $cond: [hasVector, 1, 0] } },
          embeddedCharCount: { $sum: { $cond: [hasVector, charLen, 0] } },
        },
      },
      { $project: { _id: 0, terminalChunkCount: 1, embeddedChunkCount: 1, embeddedCharCount: 1 } },
    ]);
    return agg ?? { terminalChunkCount: 0, embeddedChunkCount: 0, embeddedCharCount: 0 };
  }

  async updateEmbeddingModel(fabFileId: string, embeddingModel: string): Promise<void> {
    await this.fabFileChunkModel.updateMany({ fabFileId }, { $set: { embeddingModel } });
  }

  /**
   * One page of vector-bearing chunks that predate the `embeddingModel` discriminator field,
   * ascending by `_id` - the backfill script's keyset cursor (see packages/scripts/datalake).
   * Vectorless chunks are excluded: there is nothing to attribute a model to. Only `vector`'s
   * LENGTH is projected, not its contents - the backfill only needs the width to guess a
   * legacy file's model, and pulling full vectors here would be a large, pointless payload.
   */
  async findChunksMissingEmbeddingModel(options: { limit?: number; afterChunkId?: string } = {}) {
    const { limit = 5_000, afterChunkId } = options;
    const docs = await this.fabFileChunkModel
      .find({
        embeddingModel: { $exists: false },
        vector: { $exists: true, $ne: [] },
        ...(afterChunkId ? { _id: { $gt: afterChunkId } } : {}),
      })
      .select({ _id: 1, fabFileId: 1, vector: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => ({
      id: String(d._id),
      fabFileId: String(d.fabFileId),
      vectorLength: Array.isArray(d.vector) ? d.vector.length : 0,
    }));
  }

  /**
   * Atlas `$vectorSearch` over a bounded file subset, scoped to one embedding model - the
   * caller (see dataLakeService/atlasVectorSearch.ts) is responsible for only passing files it
   * has already established are Atlas-eligible for `model`. Returns [] rather than throwing when
   * `model` has no registered Atlas index, so a caller that forgets the eligibility check fails
   * closed (falls back to the brute-force scan) instead of hitting a server-side index-not-found
   * error.
   */
  async vectorSearch(
    fileIds: string[],
    queryVector: number[],
    model: string,
    options: { limit?: number } = {}
  ): Promise<Array<{ id: string; fabFileId: string; text: string; score: number }>> {
    if (fileIds.length === 0) return [];
    const target = getAtlasIndexForModel(model);
    if (!target) return [];

    const { limit = 50 } = options;
    // Atlas applies `filter` DURING HNSW traversal, not as a post-filter, but recall still
    // degrades as the filter gets more selective relative to the collection - and `fabfilechunks`
    // holds every user's chunks, while `fileIds` here is usually a handful of files out of that
    // whole collection. Scaling candidates with the file-set size (not just `limit`) keeps the
    // pool wide enough for a highly selective query; the per-file multiplier is a starting point,
    // not a measured constant - retune against a real lake if recall still looks low in practice.
    // Floored at 100, capped at Atlas's 10_000 max.
    const numCandidates = Math.min(10_000, Math.max(limit * 10, fileIds.length * 50, 100));

    const pipeline = [
      {
        $vectorSearch: {
          index: target.name,
          path: 'vector',
          queryVector,
          numCandidates,
          limit,
          filter: { $and: [{ fabFileId: { $in: fileIds } }, { embeddingModel: model }] },
        },
      },
      { $project: { _id: 1, fabFileId: 1, text: 1, score: { $meta: 'vectorSearchScore' } } },
    ];

    // any: $vectorSearch and the $meta vectorSearchScore projection are Atlas-only aggregation
    // syntax outside Mongoose's typed PipelineStage union; see documentdb-compat.ts's module
    // header for the same any-at-the-aggregation-boundary rationale.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs = await this.fabFileChunkModel.aggregate(pipeline as any);
    return docs.map((d: { _id: unknown; fabFileId: unknown; text?: string; score: number }) => ({
      id: String(d._id),
      fabFileId: String(d.fabFileId),
      text: d.text ?? '',
      score: d.score,
    }));
  }

  async getAtlasIndexStatus(model: string): Promise<{ queryable: boolean; status: string } | null> {
    return getAtlasIndexStatusForModel(mongoose.connection, model);
  }

  /**
   * One page of chunk ids still missing `charLength`, ascending by `_id` - the char-length
   * backfill's keyset cursor (packages/scripts/datalake/backfill-chunk-char-length.ts).
   * `charLength: null` deliberately matches missing AND explicit null.
   */
  async findChunkIdsMissingCharLength(options: { limit?: number; afterChunkId?: string } = {}): Promise<string[]> {
    const { limit = 5_000, afterChunkId } = options;
    const docs = await this.fabFileChunkModel
      .find({ charLength: null, ...(afterChunkId ? { _id: { $gt: afterChunkId } } : {}) })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => String(d._id));
  }

  /**
   * Stamp `charLength` on the given chunks server-side: a pipeline update computing $strLenCP
   * over the stored text, so chunk text never leaves the database. Counts Unicode code points -
   * the same number countCodePoints produces on the live write path (see that helper's comment
   * for why the two must agree).
   */
  async backfillCharLengthByIds(chunkIds: string[]): Promise<number> {
    if (chunkIds.length === 0) return 0;
    const result = await this.fabFileChunkModel.updateMany({ _id: { $in: chunkIds } }, [
      { $set: { charLength: { $strLenCP: '$text' } } },
    ]);
    return result.modifiedCount;
  }

  /** Sum of a file's chunks' charLength, unstamped chunks counted as 0 - backfill phase 2 input. */
  async sumChunkCharLengthByFabFileId(fabFileId: string): Promise<number> {
    const [agg] = await this.fabFileChunkModel.aggregate<{ total: number }>([
      { $match: { fabFileId } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$charLength', 0] } } } },
    ]);
    return agg?.total ?? 0;
  }

  async computeFileChunkRollups(fabFileId: string): Promise<{
    chunkedCharCount: number;
    maxChunkCharLength: number;
    embeddedChunkCount: number;
    embeddedCharCount: number;
  }> {
    // All four lake-health (#1666) file rollups in ONE pass over the file's chunks, for the backfill.
    // `vector` size, not `vector.0` existence, because the per-chunk conditional cannot pre-filter -
    // the same pass also sums ALL chunks for chunkedCharCount/maxChunkCharLength. Server-side; one-time.
    const isEmbedded = { $gt: [{ $size: { $ifNull: ['$vector', []] } }, 0] };
    const charLen = { $ifNull: ['$charLength', 0] };
    const [agg] = await this.fabFileChunkModel.aggregate<{
      chunkedCharCount: number;
      maxChunkCharLength: number;
      embeddedChunkCount: number;
      embeddedCharCount: number;
    }>([
      { $match: { fabFileId } },
      {
        $group: {
          _id: null,
          chunkedCharCount: { $sum: charLen },
          maxChunkCharLength: { $max: charLen },
          embeddedChunkCount: { $sum: { $cond: [isEmbedded, 1, 0] } },
          embeddedCharCount: { $sum: { $cond: [isEmbedded, charLen, 0] } },
        },
      },
      { $project: { _id: 0, chunkedCharCount: 1, maxChunkCharLength: 1, embeddedChunkCount: 1, embeddedCharCount: 1 } },
    ]);
    return agg ?? { chunkedCharCount: 0, maxChunkCharLength: 0, embeddedChunkCount: 0, embeddedCharCount: 0 };
  }
}

const FabFileChunkSchema = new Schema<IFabFileChunkDocument, IFabFileModel>(
  {
    text: { type: String, required: true },
    fabFileId: {
      type: String,
      ref: 'FabFile',
      required: true,
    },
    tokenCount: { type: Number, required: true },
    // Unicode code points of `text` (countCodePoints / $strLenCP); see IFabFileChunk.charLength.
    charLength: { type: Number, required: false },
    vector: { type: [Number], required: false },
    embeddingModel: { type: String, required: false },
    // Index residency, NOT readiness - see IFabFileChunk.retrievalIndexModel for why the two
    // cannot be the same field.
    retrievalIndexModel: { type: String, required: false },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
      },
    },
    toObject: {
      virtuals: true,
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
      },
    },
  }
);

// Equality on the prefix + sort on `_id` lets the planner SORT_MERGE the per-file index scans
// instead of collecting and sorting them, which is what keeps findVectorsByFabFileIds' keyset
// paging non-blocking. Deliberately the only declaration: this compound's leftmost prefix already
// serves the bare `fabFileId` reads (findByFabFileId, findTextsByFabFileId, countByFabFileId,
// deleteManyByFabFileId, computeChunkVectorRollup),
// and a `{ _id: 1, fabFileId: 1 }` buys nothing over `_id_` since `vector` is in neither index, so
// both plans fetch anyway. Environments deployed before this still held those two as orphans;
// 20260810000000_drop-legacy-fabfilechunk-indexes.ts drops them. Nothing recreates them, because
// autoIndex only builds what is declared here. fabFileChunkIndexes.test.ts pins the set.
FabFileChunkSchema.index({ fabFileId: 1, _id: 1 });

export const FabFileChunk =
  (mongoose.models.FabFileChunk as IFabFileChunkModel) ??
  mongoose.model<IFabFileChunkDocument, IFabFileChunkModel>('FabFileChunk', FabFileChunkSchema);

export const fabFileChunkRepository = new FabFileChunkRepository(FabFileChunk);

/**
 * Projection for metadata-only reads. Drops the heavy payload fields (matching
 * the exclusion used by `executeSearch`) AND the two URL-bearing fields, so a
 * metadata read can never carry a downloadable link even if a caller later
 * forwards the document verbatim.
 */
const METADATA_ONLY_PROJECTION = { content: 0, chunks: 0, vector: 0, presignedUrl: 0, fileUrl: 0 } as const;

/** Row cap for unbounded metadata listings. */
const METADATA_PAGE_CAP = 500;

/** In-flight per-document resets in resetChunkStateByIds. Kept near the connection pool size
 *  (maxPoolSize defaults to 2) so a wave cannot monopolize every connection in the process. */
const RESET_CONCURRENCY = 10;

// Lakes per `$facet` aggregate in countDataLakeFilesByMembership and the ceiling on the
// per-prefix branch count in countDataLakeUniqueFilesByPrefix. Each branch is an extra in-memory
// pass over the chunk's matched union, so this trades round trips against the server-side work
// one query does.
const LAKE_COUNT_CHUNK = 25;

/** Byte ceiling for one lake-count aggregate's query document, well under the 16MB BSON limit.
 *  Only countDataLakeUniqueFilesByPrefix needs it: its per-prefix filter carries the caller's
 *  ownership filter, which is itself O(lakes) - it names every accessible lake - so a FIXED
 *  branch count makes the document quadratic in the lake count. It crossed the BSON limit at
 *  ~640 lakes and the endpoint 500d. Branch count is derived from this budget instead, so the
 *  document stays bounded at any lake count. countDataLakeFilesByMembership needs no such
 *  derivation: its per-scope filter names one lake, so its documents are O(LAKE_COUNT_CHUNK). */
const LAKE_COUNT_QUERY_BUDGET_BYTES = 4_000_000;

/** Chunk aggregates in flight per lake-count leg. Same reasoning as RESET_CONCURRENCY: the pool
 *  defaults to 2, so a handful in flight keeps it busy while the next query is planned, and the
 *  cap stops one admin request monopolizing every connection - the two legs run concurrently with
 *  each other, so an unbounded fan-out on either starves the other. */
const LAKE_COUNT_CONCURRENCY = 4;

/** Runs `task` over `items` in batches of `limit`, awaiting each batch before starting the next.
 *  A batch barrier, not a sliding window: one slow item holds up its batch's successors. */
const mapBounded = async <T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    results.push(...(await Promise.all(items.slice(i, i + limit).map(task))));
  }
  return results;
};

export class FabFileRepository extends BaseRepository<IFabFileDocument> implements IFabFileRepository {
  shareable: IFabFileRepository['shareable'];
  constructor(
    private fabFileModel: IFabFileModel,
    extensions: { shareable: IFabFileRepository['shareable'] }
  ) {
    super(fabFileModel);
    this.shareable = extensions.shareable;
  }

  async search(
    userId: string,
    search: string,
    filters: {
      tags?: string[];
      type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code' | 'audio';
      shared?: boolean;
      curated?: boolean;
      fileIds?: string[];
      restrictToFileIds?: string[];
    },
    pagination: { page: number; limit: number },
    order: { by: 'createdAt' | 'fileName' | 'fileSize'; direction: 'asc' | 'desc' },
    options?: {
      textSearch?: boolean;
      includeShared?: boolean;
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
      restrictToDataLake?: boolean;
      /** Server-supplied only - see buildOwnershipConditions.lakeMembership. */
      lakeMembership?: DataLakeMembershipScope;
      skipOwnership?: boolean;
      excludeContent?: boolean;
      excludeFilenameMarkers?: string[];
      vectorizedOnly?: boolean;
      stableSort?: boolean;
    }
  ) {
    const query = buildFabFileSearchQuery({ userId, search, filters, pagination, order, options });
    return this.executeSearch(query, pagination.limit);
  }

  async executeSearch(
    query: {
      filter: Record<string, unknown>;
      sort: Record<string, 1 | -1>;
      collation: { locale: string } | null;
      skip: number;
      limit: number;
      excludeContent?: boolean;
    },
    pageSize: number
  ) {
    const findQuery = this.fabFileModel.find(query.filter);

    if (query.collation) {
      findQuery.collation(query.collation);
    }

    if (query.excludeContent) {
      findQuery.select({ content: 0, chunks: 0, vector: 0 });
    }

    // Mirror collation on the count query so total can never diverge from the
    // collated find result if a future filter ever adds a string-equality predicate.
    const countQuery = this.fabFileModel.countDocuments(query.filter);
    if (query.collation) countQuery.collation(query.collation);
    const total = await countQuery;

    findQuery.skip(query.skip);
    findQuery.limit(query.limit);
    findQuery.sort(query.sort);

    const result = await findQuery.exec();

    return {
      data: result.slice(0, pageSize).map(r => r.toJSON()),
      hasMore: result.length > pageSize,
      total,
    };
  }

  async findAllInIds(ids: string[]) {
    const result = await this.fabFileModel.find({ _id: { $in: ids } });
    return result.map(d => d.toObject());
  }

  /**
   * Metadata-only fetch for a set of ids. The heavy fields AND the URL-bearing
   * ones are projected out (see METADATA_ONLY_PROJECTION), so a caller that only
   * needs to know *what* was attached never loads the file bodies and cannot
   * accidentally hand out a download URL.
   *
   * Invalid ObjectIds are dropped rather than throwing a BSONError, since the ids
   * come from a session's `knowledgeIds` and can outlive the file.
   *
   * Soft-deleted files ARE returned here, via the plugin's explicit
   * `includeDeleted` opt-in: an id handed to this method comes from a reference
   * that outlived the file (e.g. `session.knowledgeIds`), and "this attachment was
   * deleted at T" is the answer the caller needs - silently dropping the row would
   * look identical to the file never having existed. Callers should surface
   * `deletedAt`. This deliberately differs from `findMetadataBySessionId` below,
   * which lists what a session currently holds; do not "fix" one to match the other.
   *
   * Bounded like its sibling: the id list is caller-supplied and a session can
   * accumulate knowledge references without limit, so an uncapped `$in` would size
   * both the query and the response off whatever that array grew to. `hasMore`
   * reports the truncation so a caller can say the list is partial rather than
   * under-reporting it as complete.
   */
  async findMetadataByIds(
    ids: string[],
    cap = METADATA_PAGE_CAP
  ): Promise<{ data: IFabFileDocument[]; hasMore: boolean }> {
    const validIds = ids.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) return { data: [], hasMore: false };
    const result = await this.fabFileModel
      .find({ _id: { $in: convertIds(validIds.slice(0, cap + 1)) } }, METADATA_ONLY_PROJECTION)
      .setOptions({ includeDeleted: true })
      .limit(cap + 1);
    const hasMore = result.length > cap;
    const rows = hasMore ? result.slice(0, cap) : result;
    return { data: rows.map(d => d.toJSON()), hasMore };
  }

  /**
   * As `findMetadataByIds`, for the files a session currently holds. Excludes
   * soft-deleted files - see the note above on why the two differ.
   *
   * Bounded at METADATA_PAGE_CAP rows; a session with more uploads than that is
   * truncated rather than returning an unbounded list. `hasMore` lets the caller
   * say so instead of silently under-reporting.
   */
  async findMetadataBySessionId(
    sessionId: string,
    cap = METADATA_PAGE_CAP
  ): Promise<{ data: IFabFileDocument[]; hasMore: boolean }> {
    const result = await this.fabFileModel
      .find({ sessionId, deletedAt: null }, METADATA_ONLY_PROJECTION)
      .sort({ createdAt: 1, _id: 1 })
      .limit(cap + 1);
    const hasMore = result.length > cap;
    const rows = hasMore ? result.slice(0, cap) : result;
    return { data: rows.map(d => d.toJSON()), hasMore };
  }

  async deleteManyInIds(ids: string[]) {
    await this.fabFileModel.deleteMany({ _id: { $in: ids } });
  }

  async getAccessibleFiles(fabFileIds: string[], scope: Record<string, unknown>) {
    // Filter out invalid ObjectIds to prevent BSONError crashes
    const validIds = fabFileIds.filter(id => mongoose.Types.ObjectId.isValid(id));

    // const accessible = accessibleBy(ability, Permission.update).ofType(FabFile);
    const filter = {
      _id: {
        $in: convertIds(validIds),
      },
      ...scope,
      // ...accessible,
    };
    return await super.find(filter, { content: 0 });
  }

  async findAllByIds(ids: string[]) {
    const result = await this.fabFileModel.find({ _id: { $in: ids } });
    return result.map(d => d.toJSON());
  }

  async findByIdAndUserId(id: string, userId: string) {
    return this.fabFileModel.findOne({ _id: id, userId });
  }

  async findByUserId(userId: string): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({ userId, deletedAt: null });
    return result.map(d => d.toJSON());
  }

  /**
   * Total `fileSize` of a user's non-deleted files, summed in the database so no
   * documents are hydrated - the only thing recalculateUserStorage needs is the
   * integer. `$ifNull` makes a missing or null `fileSize` count as 0, matching the
   * `|| 0` the load-all-and-reduce caller used to apply (the schema types `fileSize`
   * as a Number, so a non-numeric value is unreachable). Same live-file filter
   * as findByUserId; mirrors the aggregate shape in computeDataLakeStats.
   */
  async sumFileSizeByUserId(userId: string): Promise<number> {
    const [row] = await this.fabFileModel.aggregate<{ total: number }>([
      { $match: { userId, deletedAt: null } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$fileSize', 0] } } } },
      { $project: { _id: 0, total: 1 } },
    ]);
    return row?.total ?? 0;
  }

  async findByBatchId(batchId: string): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({ batchId, deletedAt: null });
    return result.map(d => d.toJSON());
  }

  async countByUserIdAndTag(userId: string, tag: string): Promise<number> {
    if (!tag) return 0;
    // Anchored and escaped for the same reason as removeTagByUserId, which queries this same
    // tags.name data: unanchored, `test` counted every file carrying `testing` too.
    const result = await this.fabFileModel.countDocuments({
      userId,
      deletedAt: null,
      tags: {
        $elemMatch: {
          name: new RegExp(`^${escapeRegex(tag)}$`, 'i'),
        },
      },
    });
    return result;
  }

  async countFilesByTagForUser(
    userId: string,
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
      excludePersonalShares?: boolean;
    }
  ): Promise<{ tag: string; count: number }[]> {
    // When options are provided, include shared/group/data-lake files (narrowed by
    // excludePersonalShares when the caller opts in - see buildOwnershipConditions).
    // Without options, only count files owned by the user (backward compatible).
    const ownershipFilter = options ? { $or: buildOwnershipConditions(userId, options) } : { userId };
    const sessionFilter = {
      $or: [
        { sessionId: null },
        { sessionId: { $exists: false } },
        { tags: { $elemMatch: { name: 'curated-notebook' } } },
      ],
    };

    const result = await this.fabFileModel.aggregate([
      {
        $match: {
          $and: [ownershipFilter, sessionFilter],
          deletedAt: null,
          // archivedAt must mirror buildFabFileSearchQuery's baseFilter: this count is rendered
          // as a badge beside the list that filter produces. Equality to null matches missing
          // too, leaving files that were never archived alone. Ownership scope is the one
          // deliberate exception, and only for a caller that opts into excludePersonalShares
          // (WORKSPACES via counts.ts) - see buildOwnershipConditions for why. listFileTags does
          // NOT opt in, so its fileCount stays in step with the file list it is rendered beside.
          archivedAt: null,
          tags: { $exists: true, $ne: [] },
        },
      },
      {
        $unwind: '$tags',
      },
      {
        $group: {
          _id: '$tags.name',
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          tag: '$_id',
          count: 1,
          _id: 0,
        },
      },
    ]);
    return result;
  }

  /**
   * Counts tags matching specific prefixes across data-lake-accessible files.
   * Used by the Data Lake Explorer to build the tag tree without fetching all articles.
   */
  async countDataLakeTagsByPrefix(
    userId: string,
    tagPrefixes: string[],
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
    }
  ): Promise<{ tag: string; count: number }[]> {
    const usablePrefixes = usableTagPrefixes(tagPrefixes);
    if (usablePrefixes.length === 0) return [];

    const ownershipFilter = options ? { $or: buildOwnershipConditions(userId, options) } : { userId };
    const sessionFilter = {
      $or: [
        { sessionId: null },
        { sessionId: { $exists: false } },
        { tags: { $elemMatch: { name: 'curated-notebook' } } },
      ],
    };

    const prefixPattern = usablePrefixes.map(p => escapeRegex(p)).join('|');
    const prefixRegex = new RegExp(`^(${prefixPattern})`);

    const result = await this.fabFileModel.aggregate([
      {
        // Pre-unwind filter: use $elemMatch with the prefix regex so MongoDB can use
        // the tags.name index and skip non-data-lake files entirely before the $unwind
        // stage materializes every tag of every file.
        $match: {
          $and: [ownershipFilter, sessionFilter],
          deletedAt: null,
          // Load-bearing, not just symmetry with the list: archiving a lake stamps archivedAt on
          // its prefix-tagged files, and a file caught by a COLLIDING sibling prefix belongs to a
          // lake that is still active (see archiveDataLake). Its prefix therefore does reach this
          // aggregate, so without the conjunct that lake's tag tree counts files its own browse
          // hides.
          archivedAt: null,
          tags: { $elemMatch: { name: { $regex: prefixRegex } } },
        },
      },
      { $unwind: '$tags' },
      { $match: { $and: [{ 'tags.name': { $regex: prefixRegex } }, { 'tags.name': NOT_META_TAG }] } },
      { $group: { _id: '$tags.name', count: { $sum: 1 } } },
      { $project: { tag: '$_id', count: 1, _id: 0 } },
    ]);
    return result;
  }

  /**
   * Unique data-lake FILE counts (not tag occurrences) under the same scoping as
   * countDataLakeTagsByPrefix. Returns the combined unique total plus a per-prefix
   * breakdown. NOTE: per-prefix counts can sum to MORE than `total` if a single file
   * carries tags from multiple lakes (counted once per lake but once overall), so `total`
   * is computed independently via its own count rather than by summing the breakdown.
   */
  async countDataLakeUniqueFilesByPrefix(
    userId: string,
    tagPrefixes: string[],
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
    }
  ): Promise<{ total: number; byPrefix: Record<string, number> }> {
    const usablePrefixes = usableTagPrefixes(tagPrefixes);
    if (usablePrefixes.length === 0) return { total: 0, byPrefix: {} };

    const ownershipFilter = options ? { $or: buildOwnershipConditions(userId, options) } : { userId };
    const sessionFilter = {
      $or: [
        { sessionId: null },
        { sessionId: { $exists: false } },
        { tags: { $elemMatch: { name: 'curated-notebook' } } },
      ],
    };
    // archivedAt: null for the same reason as countDataLakeTagsByPrefix above - a colliding
    // sibling lake's files are archived while that lake itself stays active.
    const accessMatch = { $and: [ownershipFilter, sessionFilter] };

    // $elemMatch on the anchored prefix regex lets MongoDB use the tags.name index and counts
    // each file once regardless of how many matching tags it carries.
    //
    // Deliberately WITHOUT `accessMatch`: this arm is repeated once per prefix in the unions
    // below, and `accessMatch` is O(lakes) - `buildOwnershipConditions` names every accessible
    // lake's meta-tag and prefix - so folding it in here squares the query document. Access is
    // applied once, past a `$facet` barrier; `scopedPrefixMatch` is the conjunction where a
    // single filter is needed.
    const prefixMatch = (prefix: string) => ({
      tags: { $elemMatch: { name: { $regex: new RegExp(`^${escapeRegex(prefix)}`), ...NOT_META_TAG } } },
      deletedAt: null,
      archivedAt: null,
    });
    const scopedPrefixMatch = (prefix: string) => ({ $and: [accessMatch, prefixMatch(prefix)] });

    // Every union below is `$or` of the single-prefix arms, NEVER one `^(a|b|c)` alternation:
    // a regex only yields index bounds when `^` is followed by literal characters, so an
    // alternation drops `tags.name` entirely and scans every tag of every file in the install.
    // `$or` lets the planner bound each arm and union the results.
    //
    // The `$facet` is a planner barrier as much as a fan-out: consecutive `$match` stages
    // coalesce into one `$and`, and an `$and` wrapping the union is no longer a ROOTED `$or`,
    // which is the only form the subplanner bounds per arm. Applying access inside a branch is
    // what keeps one copy of the O(lakes) filter AND the index bounds - measured at 525 keys
    // examined either way, against 20,500 for both the coalesced and the alternation shapes.
    const countTotal = async () => {
      const [row] = await this.fabFileModel.aggregate<{ total?: { n: number }[] }>([
        { $match: { $or: usablePrefixes.map(prefixMatch) } },
        { $facet: { total: [{ $match: accessMatch }, { $count: 'n' }] } },
      ]);
      return row?.total?.[0]?.n ?? 0;
    };

    // The per-prefix breakdown fans out over `$facet` branches for the same reason as
    // countDataLakeFilesByMembership: `tagPrefixes` is one entry per lake the caller can see,
    // which on the admin tag-count path is every lake of every tenant. Branches stay independent
    // because a file carrying two lakes' prefixes must count once for EACH - the reason the
    // docblock above warns that `byPrefix` can outsum `total`.
    //
    // A branch cannot share the outer access match (each needs access AND its own prefix), so the
    // branch count - unlike countDataLakeFilesByMembership's - is derived from the byte budget
    // rather than fixed: `accessMatch` grows with the lake set, so a fixed 25 branches is what
    // put this query over the BSON limit at ~640 lakes. It degrades to one prefix per aggregate
    // rather than throwing.
    const accessMatchBytes = mongoose.mongo.BSON.calculateObjectSize(accessMatch);
    const branchCount = Math.max(
      1,
      Math.min(LAKE_COUNT_CHUNK, Math.floor(LAKE_COUNT_QUERY_BUDGET_BYTES / Math.max(accessMatchBytes, 1)))
    );

    const byPrefix: Record<string, number> = {};
    const chunkCounts = async (start: number) => {
      const chunk = usablePrefixes.slice(start, start + branchCount);
      // Synthetic branch keys: a facet field name may not contain a '.' or start with a '$',
      // and a prefix is a user-derived string. Mapped back positionally.
      const [row] = await this.fabFileModel.aggregate<Record<string, { n: number }[]>>([
        { $match: { $or: chunk.map(prefixMatch) } },
        {
          $facet: Object.fromEntries(
            chunk.map((prefix, j) => [`p${j}`, [{ $match: scopedPrefixMatch(prefix) }, { $count: 'n' }]])
          ),
        },
      ]);
      chunk.forEach((prefix, j) => {
        byPrefix[prefix] = row?.[`p${j}`]?.[0]?.n ?? 0;
      });
    };

    const chunkStarts = Array.from(
      { length: Math.ceil(usablePrefixes.length / branchCount) },
      (_, i) => i * branchCount
    );
    // `total` stays its own count rather than a sum of the branches, per the docblock above.
    const [total] = await Promise.all([countTotal(), mapBounded(chunkStarts, LAKE_COUNT_CONCURRENCY, chunkCounts)]);

    return { total, byPrefix };
  }

  /**
   * Per-namespace unique file counts, served alongside countFilesByTagForUser by
   * GET /api/files/tags/counts. That route calls the sibling twice with two different scopes
   * (unnarrowed for tagCounts, excludePersonalShares:true for workspaceTagCounts); this must be
   * called with the SAME (narrowed) scope as the workspaceTagCounts call specifically, since the
   * workspace rows are keyed off that count but sized by this one - an owner-only namespace
   * count renders a shared or data-lake workspace as zero.
   */
  async countUniqueFilesByNamespaceForUser(
    userId: string,
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
      excludePersonalShares?: boolean;
    }
  ): Promise<{ namespace: string; fileCount: number }[]> {
    // Caller must pass the SAME options (including excludePersonalShares) as
    // countFilesByTagForUser - see that function's doc comment.
    const ownershipFilter = options ? { $or: buildOwnershipConditions(userId, options) } : { userId };
    // Exclude session summaries (unless curated-notebook) to match search behavior. Both this and
    // the ownership filter can be an $or, so they go under $and rather than into one object where
    // the second $or key would overwrite the first.
    const sessionFilter = {
      $or: [
        { sessionId: null },
        { sessionId: { $exists: false } },
        { tags: { $elemMatch: { name: 'curated-notebook' } } },
      ],
    };

    const result = await this.fabFileModel.aggregate([
      {
        $match: {
          $and: [ownershipFilter, sessionFilter],
          deletedAt: null,
          // See countFilesByTagForUser: a count beside a list covers the list's file set.
          archivedAt: null,
          tags: { $exists: true, $ne: [] },
        },
      },
      { $unwind: '$tags' },
      {
        // Extract root namespace (part before first ":")
        $addFields: {
          rootNamespace: {
            $cond: {
              if: { $eq: [{ $indexOfCP: ['$tags.name', ':'] }, -1] },
              then: '$tags.name',
              else: { $substrCP: ['$tags.name', 0, { $indexOfCP: ['$tags.name', ':'] }] },
            },
          },
        },
      },
      {
        // Count unique files per namespace
        $group: {
          _id: { namespace: '$rootNamespace', fileId: '$_id' },
        },
      },
      {
        $group: {
          _id: '$_id.namespace',
          fileCount: { $sum: 1 },
        },
      },
      {
        $project: {
          namespace: '$_id',
          fileCount: 1,
          _id: 0,
        },
      },
      { $sort: { fileCount: -1 } },
    ]);
    return result;
  }

  async removeTagByUserId(userId: string, tag: string): Promise<number> {
    if (!tag) return 0;
    // Anchored, not a substring match: unanchored, removing `test` also stripped `testing` and
    // `unit-test` off every file. Escaped because a tag name is user-chosen and can carry regex
    // metacharacters. Case-insensitive so a `Foo` document also clears files carrying `foo`.
    const nameRegex = new RegExp(`^${escapeRegex(tag)}$`, 'i');
    // No deletedAt conjunct, unlike most reads here: a soft-deleted file that kept the name would
    // resurrect a tag document that no longer exists the moment it is undeleted.
    const result = await this.fabFileModel.updateMany(
      {
        userId,
        tags: {
          $elemMatch: {
            name: nameRegex,
          },
        },
      },
      {
        $pull: {
          tags: {
            name: nameRegex,
          },
        },
      }
    );
    // Same reasoning as pullTagsByFabFileId: a primaryTag naming a tag the file no longer carries
    // later fails the data-lake write gate on PUT /api/files/[id]. Separate filtered write because
    // a plain update cannot clear a field conditionally on its own value.
    await this.fabFileModel.updateMany({ userId, primaryTag: nameRegex }, { $unset: { primaryTag: '' } });
    return result.modifiedCount;
  }

  async bulkUpdateTags(
    updates: {
      id: string;
      tags: { name: string; strength: number }[];
      expectedTags: { name: string; strength: number }[];
    }[]
  ): Promise<number> {
    if (updates.length === 0) return 0;

    // `tags: expectedTags` is an exact, order-sensitive array match (Mongo array-equality
    // semantics) - ANY concurrent change (add/remove/reorder) makes this op a no-op rather
    // than overwriting with a merge computed from data that's no longer current. Order-
    // sensitivity is safe only because every other tags writer in this file (push/pull/dedupe)
    // preserves order - it appends or removes, never reshuffles. That's an invariant of those
    // methods, not of this one; a future writer that resorts/rebuilds `tags` would silently
    // defeat this CAS. Keep it that way, or switch to a version counter instead of a full-array
    // compare.
    //
    // `tags` is a schema-less [Object] array with no default enforced on legacy rows (see the
    // $ifNull guards in dedupeTagByUserId above), so "no tags" can be stored as `null`, an
    // absent field, or `[]`. A caller's `file.tags ?? []` read collapses all three to `[]`
    // before it ever reaches expectedTags, so an exact-array filter of `{ tags: [] }` would
    // never match the null/missing cases and permanently strand those files. `{ tags: null }`
    // alone covers both the explicit-null and the missing-field case (Mongo treats them as the
    // same match), so two clauses - not three - cover all storage forms as equivalent to an
    // empty snapshot, mirroring the read side.
    const result = await this.fabFileModel.bulkWrite(
      updates.map(({ id, tags, expectedTags }) => ({
        updateOne: {
          filter: {
            _id: convertId(id),
            deletedAt: null,
            ...(expectedTags.length === 0 ? { $or: [{ tags: [] }, { tags: null }] } : { tags: expectedTags }),
          },
          update: { $set: { tags } },
        },
      })),
      { ordered: false, session: this._txn ?? undefined }
    );
    return result.modifiedCount;
  }

  /**
   * Atomically mark a file as failed only if it isn't already errored.
   * Returns true if THIS call performed the marking (i.e. first failure), false on retry.
   * Used by queue handlers to avoid double-incrementing batch failure counters when SQS
   * redelivers a message for an already-failed file.
   */
  async markFailedIfNotAlready(fabFileId: string, errorMessage: string): Promise<boolean> {
    const result = await this.fabFileModel.findOneAndUpdate(
      { _id: fabFileId, $or: [{ error: null }, { error: { $exists: false } }, { error: '' }] },
      { $set: { error: errorMessage, isVectorizing: false } },
      { new: false }
    );
    return result !== null;
  }

  async confirmChunkClaim(fabFileId: string, chunkClaimedAt: Date): Promise<boolean> {
    // The WRITE succeeding or not is the signal (#1802 Phase 2), not any field it changes - but the
    // write must ACTUALLY be a write, not a no-op MongoDB is free to elide. A bare
    // `$set: {chunkClaimedAt}` writes back the value it just matched on, and verified against a
    // real replica set: when nothing else in the update changes, a concurrent non-transactional
    // takeover landing inside this transaction's snapshot window can be silently invisible to it -
    // the match succeeds against the stale snapshot and no conflict is ever raised. `chunkClaimedAt`
    // stays untouched deliberately (fabFileChunk.ts's release CAS matches on this run's exact
    // original stamp), so chunkClaimConfirmedAt exists for the sole purpose of making this write
    // always genuinely different, so MongoDB can never treat it as a no-op regardless of whether
    // this schema's `timestamps` option happens to be doing the same job by accident.
    const result = await this.fabFileModel.findOneAndUpdate(
      { _id: fabFileId, chunkClaimedAt },
      { $set: { chunkClaimedAt, chunkClaimConfirmedAt: new Date() } },
      { new: false }
    );
    return result !== null;
  }

  async setChunkPolicyConflict(
    fabFileId: string,
    chunkedPassageTokenTarget: number,
    conflict: FabFileChunkPolicyConflict | null
  ): Promise<void> {
    // One atomic $set so the recorded target and the conflict decided from it can never disagree
    // (#1662). `null` clears a now-resolved conflict; the target is always recorded.
    await this.fabFileModel.updateOne(
      { _id: fabFileId },
      { $set: { chunkedPassageTokenTarget, chunkPolicyConflict: conflict } }
    );
  }

  async findByContentHashes(userId: string, hashes: string[]): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({
      userId,
      contentHash: { $in: hashes },
      deletedAt: null,
      // Exclude incomplete/orphan uploads: a record is created with the hash before the
      // upload lands and stays 'pending' if it never completes, so a failed prior upload
      // would otherwise block a legit re-upload. $ne (not === 'complete') is deliberate -
      // it drops only the known-incomplete state and preserves legacy/undefined-status rows.
      status: { $ne: 'pending' },
    });
    return result.map(d => d.toJSON());
  }

  async findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({
      contentHash: { $in: hashes },
      deletedAt: null,
      archivedAt: null,
      tags: { $elemMatch: { name: datalakeTag } },
      // Same incomplete-upload exclusion as findByContentHashes: an orphan 'pending' record
      // must not count as a live match, or sync-delta skips a legit re-upload and the restore
      // paths (un/archive, un/delete) would discard the good copy in favor of the orphan.
      status: { $ne: 'pending' },
    });
    return result.map(d => d.toJSON());
  }

  async findByServerTextHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]> {
    if (hashes.length === 0) return [];
    const result = await this.fabFileModel.find({
      serverTextHash: { $in: hashes },
      deletedAt: null,
      archivedAt: null,
      tags: { $elemMatch: { name: datalakeTag } },
      // Same orphan-pending exclusion as findByContentHashesInDataLake: a file whose ingest never
      // completed is not a live member, and treating it as one would suppress a legitimate proposal.
      status: { $ne: 'pending' },
    });
    return result.map(d => d.toJSON());
  }

  async isLiveDataLakeMember(fabFileId: string, datalakeTag: string): Promise<boolean> {
    // Deliberately WITHOUT the `status: { $ne: 'pending' }` conjunct its hash-keyed siblings carry,
    // and that divergence is the whole point. Those match on `serverTextHash`, which a file that has
    // not chunked yet does not have - so excluding 'pending' there costs nothing and stops an
    // orphaned upload from suppressing a legitimate re-upload. Here the caller already KNOWS a human
    // approved this exact file (it passes `admittedFabFileId` off the proposal row), so the only
    // question is whether the lake still holds it. A file mid-ingest is held: it was admitted, its
    // bytes are landing, and its chunks are coming. Treating 'pending' as absent re-opened the source
    // for proposal during the whole approval->ingest window, which is how a reviewer could be handed
    // a second card for content already on its way in - and approving both admits one source twice.
    // Verified live: a just-approved file sits at 'pending' until the S3 ObjectCreated handler runs.
    const found = await this.fabFileModel.exists({
      _id: fabFileId,
      deletedAt: null,
      archivedAt: null,
      tags: { $elemMatch: { name: datalakeTag } },
    });
    return found !== null;
  }

  async findByDriveFileIdsInDataLake(driveFileIds: string[], datalakeTag: string): Promise<IFabFileDocument[]> {
    if (driveFileIds.length === 0) return [];
    // The recursive Drive walk can surface up to 100k children PER folder, so an unchunked $in
    // would risk Mongo's 16 MB BSON query ceiling and a degraded plan long before it. Query in
    // id-chunks and concatenate.
    const CHUNK_SIZE = 5000;
    const results: IFabFileDocument[] = [];
    for (let i = 0; i < driveFileIds.length; i += CHUNK_SIZE) {
      const chunk = driveFileIds.slice(i, i + CHUNK_SIZE);
      const docs = await this.fabFileModel.find({
        driveFileId: { $in: chunk },
        deletedAt: null,
        archivedAt: null,
        tags: { $elemMatch: { name: datalakeTag } },
        // Same orphan-pending exclusion as findByContentHashesInDataLake: a failed prior ingest
        // left 'pending' must not block a legit re-ingest of the same Drive file.
        status: { $ne: 'pending' },
      });
      results.push(...docs.map(d => d.toJSON()));
    }
    return results;
  }

  async findByDriveConnectionIdInDataLake(driveConnectionId: string, datalakeTag: string): Promise<IFabFileDocument[]> {
    const docs = await this.fabFileModel.find({
      driveConnectionId,
      deletedAt: null,
      archivedAt: null,
      tags: { $elemMatch: { name: datalakeTag } },
      // Exclude in-flight rows: a 'pending' file from a sync still mid-upload is not yet a
      // durable member, so it must not be mistaken for a delete (absent from the fresh walk it
      // has not finished ingesting) nor for a stale copy.
      status: { $ne: 'pending' },
    });
    return docs.map(d => d.toJSON());
  }

  async findDriveFileIdsByBatchId(batchId: string): Promise<string[]> {
    // No status filter on purpose - the rows a resumed slice must recognise are the `pending` ones
    // its own earlier slices uploaded (see the interface docs). `distinct` keeps this a projection
    // over the { batchId: 1 } index rather than loading a whole slice's documents.
    const ids = await this.fabFileModel.distinct('driveFileId', { batchId, driveFileId: { $ne: null } });
    return ids.filter((id): id is string => typeof id === 'string');
  }

  // Data lake lifecycle. Membership is the two-signal rule in buildDataLakeMembershipFilter
  // (meta-tag OR a fileTagPrefix match on a file the lake's creator owns), shared with the
  // single-lake browse so a read and a whole-lake write never disagree about who is a member.

  /**
   * Authoritative lake stats from source records via an aggregate - counts only live files
   * (not archived, not deleted, not an orphan upload still `pending`). Runs at batch completion
   * AND on the reconcile read path, so it must NOT load-all-and-count.
   *
   * `status: { $ne: 'pending' }` matters here specifically because this count also drives
   * `activateIfDraft` (recomputeLakeStats.ts): a presigned FabFile row is tagged into the lake
   * before a byte is sent, and without this exclusion an upload that never completed could
   * still count toward "the lake has a member" and activate it - permanently, since the
   * transition is one-way. Same exclusion as findByContentHashes, for the same reason.
   *
   * The `{ 'tags.name': 1, archivedAt: 1, deletedAt: 1 }` index bounds the meta-tag arm fully.
   * The prefix arm is bounded by the `{ userId: 1, 'tags.name': 1, archivedAt: 1, deletedAt: 1 }`
   * index declared further down this file: `userId` equality narrows the scan to the lake
   * creator's own files before the `tags.name` range is applied, so a prefix-heavy lake no longer
   * fetches every other user's matching documents to check ownership.
   */
  async computeDataLakeStats(
    scope: DataLakeMembershipScope
  ): Promise<{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }> {
    const [agg] = await this.fabFileModel.aggregate<{
      fileCount: number;
      totalSizeBytes: number;
      totalChunkedChars: number;
    }>([
      {
        $match: {
          ...buildDataLakeMembershipFilter(scope),
          deletedAt: null,
          archivedAt: null,
          status: { $ne: 'pending' },
        },
      },
      {
        $group: {
          _id: null,
          fileCount: { $sum: 1 },
          totalSizeBytes: { $sum: { $ifNull: ['$fileSize', 0] } },
          totalChunkedChars: { $sum: { $ifNull: ['$chunkedCharCount', 0] } },
        },
      },
      { $project: { _id: 0, fileCount: 1, totalSizeBytes: 1, totalChunkedChars: 1 } },
    ]);
    return agg ?? { fileCount: 0, totalSizeBytes: 0, totalChunkedChars: 0 };
  }

  /**
   * Per-member health rollups for a lake (#1666): the raw numbers the pure predicate evaluator
   * (`summarizeLakeHealth` in @bike4mind/common) grades. Reads only FabFile documents - never the
   * chunk collection - so a lake with a million chunks still costs an O(members) file scan. Same
   * membership + liveness filter as computeDataLakeStats, and only members that produced chunks
   * (`chunkCount > 0`): a chunkless image or a still-pending upload carries no retrievable content.
   *
   * ONE exception, and it is the case this report exists for: a member the convergence kill switch
   * stopped mid-rewrite is chunkless because its passages were DELETED, not because it never had
   * any. Excluding it made a lake report "Reachable 100%" over the members it still had while a
   * document sat entirely unsearchable and absent from the drill-down - the green-counters-but-
   * broken reading the four rules exist to catch. Admitted by its marker so it grades its real zero.
   *
   * `limit` bounds how many rows reach app memory. It fetches one extra to detect overflow, so the
   * caller can report coverage as partial and log it, rather than silently truncating a percentage.
   */
  async findDataLakeHealthMembers(
    scope: DataLakeMembershipScope,
    limit = 25_000
  ): Promise<
    Array<{
      fabFileId: string;
      fileName?: string;
      chunkCount: number;
      vectorizedChunkCount: number | null;
      error: string | null;
      notes: string | null;
      chunkRebuildRequestedAt: Date | null;
      chunkedCharCount: number | null;
      maxChunkCharLength: number | null;
      embeddedChunkCount: number | null;
      embeddedCharCount: number | null;
    }>
  > {
    return this.fabFileModel.aggregate([
      {
        // buildDataLakeMembershipQuery, NOT a spread: the membership predicate's prefix arm is itself
        // a top-level `$or`, so spreading it beside this one would drop it and grade every file in
        // the install as a member of this lake.
        $match: buildDataLakeMembershipQuery(scope, {
          deletedAt: null,
          archivedAt: null,
          status: { $ne: 'pending' },
          // Plus the pending-rebuild stamp (#1939): between a wave's reset and its chunk worker's
          // commit a member is chunkless with no marker of any other kind, so without this arm it
          // leaves the denominator for the whole rebuild - and never comes back if the rebuild was
          // never enqueued. It grades as in-flight, not as a failure; see evaluateMemberHealth.
          $or: [
            { chunkCount: { $gt: 0 } },
            { notes: CONVERGENCE_PAUSED_CHUNK_NOTE },
            { chunkRebuildRequestedAt: { $ne: null } },
          ],
        }),
      },
      // Deterministic order before the truncation bound, so which members a very large lake reports
      // on (and therefore the headline it shows) is reproducible across refreshes rather than jittering.
      { $sort: { _id: 1 } },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 0,
          fabFileId: { $toString: '$_id' },
          fileName: 1,
          chunkCount: { $ifNull: ['$chunkCount', 0] },
          // Preserve null (UNMEASURED) rather than coalescing to 0 - the evaluator must tell "not yet
          // measured" from "measured as zero". $ifNull with null keeps an ABSENT field as null too.
          vectorizedChunkCount: { $ifNull: ['$vectorizedChunkCount', null] },
          // Terminal-failure marker: an errored file is graded as settled (fails P3) rather than
          // hidden as still-indexing. Preserve null so "no error" stays distinct.
          error: { $ifNull: ['$error', null] },
          // The SECOND terminal-stall marker. The convergence kill switch abandons a vectorize by
          // writing CONVERGENCE_PAUSED_NOTE to `notes` and never sets `error`, so omitting this here
          // would leave the evaluator's arm reading undefined and silently never firing - the same
          // shape as the contract gap that disabled the vectorizedChunkCount gate.
          notes: { $ifNull: ['$notes', null] },
          // The FOURTH stall/in-flight input. A member reset by a wave carries none of the three
          // above, so omitting this would admit it at the $match and then grade it as a settled
          // zero - worse than dropping it, because it would fail P3 on a rebuild that is merely
          // in progress.
          chunkRebuildRequestedAt: { $ifNull: ['$chunkRebuildRequestedAt', null] },
          chunkedCharCount: { $ifNull: ['$chunkedCharCount', null] },
          maxChunkCharLength: { $ifNull: ['$maxChunkCharLength', null] },
          embeddedChunkCount: { $ifNull: ['$embeddedChunkCount', null] },
          embeddedCharCount: { $ifNull: ['$embeddedCharCount', null] },
        },
      },
    ]);
  }

  /**
   * Per-member facts for owner-triggered convergence (#1681). See the interface doc for why this is
   * a separate read from findDataLakeHealthMembers rather than an extension of it.
   */
  async findLakeConvergenceMembers(
    scope: DataLakeMembershipScope,
    limit = 25_000
  ): Promise<
    Array<{
      fabFileId: string;
      userId: string;
      fileName?: string;
      tags: { name: string }[];
      chunkCount: number;
      vectorizedChunkCount: number | null;
      error: string | null;
      notes: string | null;
      chunkRebuildRequestedAt: Date | null;
      maxChunkCharLength: number | null;
      chunkedPassageTokenTarget: number | null;
    }>
  > {
    return this.fabFileModel.aggregate([
      {
        // buildDataLakeMembershipQuery, NOT a spread - see findDataLakeHealthMembers. Dropping the
        // membership predicate here is the worse of the two, because this read decides which files a
        // wave REWRITES: it would re-chunk other lakes' documents at this lake's target.
        $match: buildDataLakeMembershipQuery(scope, {
          deletedAt: null,
          archivedAt: null,
          status: { $ne: 'pending' },
          // `chunkCount > 0` OR the halted-rewrite marker. A member the kill switch stopped mid-wave
          // has no chunks BECAUSE ITS OWN WERE DELETED, and excluding it is what let it disappear
          // from this plan at the same time as from health and from search - repairable by exactly
          // the rewrite this plan produces, but only if it is allowed to reach the grader.
          // Same third arm as findDataLakeHealthMembers, same reason (#1939): a member between its
          // reset and its rebuild is chunkless and unmarked, and dropping it here is what let a
          // never-enqueued rebuild disappear from the plan that would have re-driven it.
          $or: [
            { chunkCount: { $gt: 0 } },
            { notes: CONVERGENCE_PAUSED_CHUNK_NOTE },
            { chunkRebuildRequestedAt: { $ne: null } },
          ],
          // A file a chunk worker is mid-run on is excluded, not refused later: its rollups describe
          // chunks that are already being replaced, so grading them would decide on stale facts.
          isChunking: { $ne: true },
        }),
      },
      // Deterministic order before the truncation bound, so a truncated plan is reproducible.
      { $sort: { _id: 1 } },
      { $limit: limit + 1 },
      {
        $project: {
          _id: 0,
          fabFileId: { $toString: '$_id' },
          userId: { $toString: '$userId' },
          fileName: 1,
          // Only the tag NAME is projected - findMemberLakesForFile is the sole consumer and reads
          // nothing else, and a lake can carry thousands of members.
          tags: { $map: { input: { $ifNull: ['$tags', []] }, as: 't', in: { name: '$$t.name' } } },
          chunkCount: { $ifNull: ['$chunkCount', 0] },
          // Preserve null (UNMEASURED) rather than coalescing to 0: the decision must tell "not yet
          // measured" from "measured as zero", and collapsing them would rewrite a whole lake whose
          // #1665 backfill has not run.
          vectorizedChunkCount: { $ifNull: ['$vectorizedChunkCount', null] },
          error: { $ifNull: ['$error', null] },
          notes: { $ifNull: ['$notes', null] },
          // See findDataLakeHealthMembers: without it a member admitted by the stamp above would be
          // graded on stale facts instead of being reported as `indexingInFlight`.
          chunkRebuildRequestedAt: { $ifNull: ['$chunkRebuildRequestedAt', null] },
          maxChunkCharLength: { $ifNull: ['$maxChunkCharLength', null] },
          chunkedPassageTokenTarget: { $ifNull: ['$chunkedPassageTokenTarget', null] },
        },
      },
    ]);
  }

  /**
   * One page of a lake's live members for the lake-memory extraction producer
   * (`extractLakeMemoryForBatch`), ascending by `_id`.
   *
   * Deliberately NOT `findIdsByDataLakeTag` + `findAllByIds`, which is what this replaced. That pair
   * returned every id the lake had ever held (tombstones included, by design - lifecycle sweeps need
   * them) and then hydrated all of them UNPROJECTED, so `content`, `chunks` and `vector` all landed in
   * the Lambda before the producer's own per-run cap applied. A lake of a few thousand ~1MB documents
   * pulled GBs into one invocation and was killed before the deadline guard could yield, and every SQS
   * redelivery was killed the same way until the message reached the DLQ.
   *
   * So the liveness filter, the ordering and the bound all run in the DATABASE, and the projection is
   * an inclusion list of exactly the three fields the producer reads: the id to fetch chunks by and to
   * persist as its continuation cursor, the file name as the extractor's doc title, and the tag names
   * that decide the evidence tier. The document text comes separately from `fabFileChunkRepository`, so
   * none of the heavy fields are wanted here at all.
   *
   * `after` is a KEYSET boundary, not an offset: ObjectId order is creation order, so a document
   * uploaded mid-scan sorts after the cursor and is picked up by a later run rather than shifting the
   * window under an in-progress one. An `after` that is not a valid ObjectId is ignored (the page
   * starts from the top) rather than throwing a cast error - the producer's ledger append de-dups, so
   * an over-broad re-scan is merely wasteful, whereas a throw would fail the run into the DLQ.
   *
   * `limit` is the caller's bound verbatim; the producer asks for one row past its cap and uses that
   * probe row to tell "the lake continues" from "the slice happened to fill exactly", which is cheaper
   * than a second count query.
   */
  async findLakeMemoryExtractionMembers(
    scope: DataLakeMembershipScope,
    options: { after?: string | null; limit: number }
  ): Promise<Array<{ fabFileId: string; fileName?: string; tags: { name: string }[] }>> {
    const after = options.after && mongoose.Types.ObjectId.isValid(options.after) ? convertId(options.after) : null;
    return this.fabFileModel.aggregate([
      {
        // buildDataLakeMembershipQuery, NOT a spread - see findDataLakeHealthMembers. An aggregate is
        // outside the soft-delete plugin's query middleware, so `deletedAt` is filtered here
        // explicitly rather than by default.
        $match: buildDataLakeMembershipQuery(scope, {
          deletedAt: null,
          archivedAt: null,
          ...(after ? { _id: { $gt: after } } : {}),
        }),
      },
      { $sort: { _id: 1 } },
      { $limit: options.limit },
      {
        $project: {
          _id: 0,
          fabFileId: { $toString: '$_id' },
          fileName: 1,
          // Only the tag NAME, as in findLakeConvergenceMembers: a lake member can carry many tags and
          // the tier decision reads nothing else off them.
          tags: { $map: { input: { $ifNull: ['$tags', []] }, as: 't', in: { name: '$$t.name' } } },
        },
      },
    ]);
  }

  /**
   * One page of file ids that have chunks but no `chunkedCharCount` (missing or nulled by a
   * content rewrite), ascending by `_id` - the char-length backfill's phase-2 cursor.
   */
  async findFileIdsMissingChunkedCharCount(options: { limit?: number; afterFileId?: string } = {}): Promise<string[]> {
    const { limit = 1_000, afterFileId } = options;
    const docs = await this.fabFileModel
      .find({
        chunkedCharCount: null,
        chunkCount: { $gt: 0 },
        ...(afterFileId ? { _id: { $gt: afterFileId } } : {}),
      })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => String(d._id));
  }

  /** Stamp a file's recomputed `chunkedCharCount` - the char-length backfill's phase-2 write. */
  async setChunkedCharCount(id: string, chunkedCharCount: number): Promise<void> {
    await this.fabFileModel.updateOne({ _id: id }, { $set: { chunkedCharCount } });
  }

  /**
   * One page of file ids with chunks but missing the lake-health (#1666) rollups, keyed by
   * `maxChunkCharLength` (absent on every file that predates the field, and on any the content-rewrite
   * patch cleared). Ascending by `_id` - the backfill's phase-2 cursor. Superset of the
   * chunkedCharCount gap: a file the #1665 backfill already gave chunkedCharCount but not these fields
   * is still selected here, so one rerun trues up both.
   */
  async findFileIdsMissingChunkRollups(options: { limit?: number; afterFileId?: string } = {}): Promise<string[]> {
    const { limit = 500, afterFileId } = options;
    const docs = await this.fabFileModel
      .find({
        maxChunkCharLength: null,
        chunkCount: { $gt: 0 },
        ...(afterFileId ? { _id: { $gt: afterFileId } } : {}),
      })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(limit)
      .lean();
    return docs.map(d => String(d._id));
  }

  /** Stamp all four recomputed chunk-derived rollups together - the health backfill's phase-2 write. */
  async setChunkRollups(
    id: string,
    rollups: {
      chunkedCharCount: number;
      maxChunkCharLength: number;
      embeddedChunkCount: number;
      embeddedCharCount: number;
    }
  ): Promise<void> {
    await this.fabFileModel.updateOne({ _id: id }, { $set: rollups });
  }

  /**
   * Distinct live file count per lake, keyed by `datalakeTag`. Browse surfaces used to size a
   * lake from `<prefix>:` tag matches, which reads 0 for a lake whose files carry only the
   * membership tag - the shape the upload wizard and bulk ingest produce - and over-counts a
   * file carrying several taxonomy tags. Same predicate and live-file filter as
   * computeDataLakeStats, so a displayed count and a lake's stored stats cannot disagree.
   */
  async findChunkedFilesByScope(scope: DataLakeMembershipScope): Promise<{ id: string; userId: string }[]> {
    const docs = await this.fabFileModel
      .find(
        // `isChunking: {$ne: true}` excludes a file a chunk WORKER is mid-run on (the worker CAS in
        // fabFileChunk.ts is the only writer of isChunking:true - no producer pre-claims), so a
        // rebuild can't select a file that is already being chunked.
        {
          ...buildDataLakeMembershipFilter(scope),
          deletedAt: null,
          archivedAt: null,
          chunked: true,
          isChunking: { $ne: true },
        },
        { _id: 1, userId: 1 }
      )
      .lean();
    return docs.map(d => ({ id: d._id.toString(), userId: String(d.userId) }));
  }

  /**
   * The lake's convergence-stranded files: everything the kill switch left with NO searchable
   * passage, by either arm. `error:null` on both, so countFailedFilesByScope cannot see them.
   *
   *  - CHUNK arm: passages deleted by a halted wave, so `chunked:false` and `chunkCount:0` - a shape
   *    findChunkedFilesByScope cannot see either, and one indistinguishable from an image or a
   *    pending upload without the marker.
   *  - VECTORIZE arm: chunks exist but carry no vector. `chunked:true`, so this file DOES appear in
   *    findChunkedFilesByScope - but only reaches the rebuild wave if it also has an oversized chunk,
   *    which a correctly-chunked file does not. QA measured a lake at `Reachable 41%` with ten such
   *    files and neither Converge nor Rebuild offered: convergence graded them conformant (they are
   *    at target) and this read passed over them, so the panel exposed no self-service repair at all.
   *
   *  - STALE-PENDING arm: a rebuild was stamped by `resetChunkStateByIds` and never committed
   *    (#1939). The producer died between the reset and its sends, or the message was lost; either
   *    way there is no marker to upgrade and nothing scheduled to rebuild it. Shaped like the CHUNK
   *    arm and invisible in exactly the same way, so it belongs behind the same door - it is simply
   *    identified by an OLD stamp instead of a note. The age bound is what keeps this door off a
   *    rebuild that is merely in flight; REBUILD_PENDING_STALE_MS derives it from the chunk queue's
   *    visibility timeout, so a message still awaiting its first redelivery is never re-driven.
   *
   * Selected by the marker plus "nothing of it is retrievable", the same condition
   * `partitionByIndexAvailability` withholds on, rather than by chunk count - so this door offers a
   * repair for exactly the population search refuses to serve. `$in` over the shared
   * CONVERGENCE_PAUSED_NOTES so it cannot drift from `isConvergencePausedNote`.
   */
  async findConvergencePausedFilesByScope(scope: DataLakeMembershipScope): Promise<{ id: string; userId: string }[]> {
    const docs = await this.fabFileModel
      .find(
        // buildDataLakeMembershipQuery, NOT a spread: the conditions below name a top-level `$or`
        // and the membership predicate's prefix arm is one too, so spreading would silently delete
        // the membership predicate and offer every file in the install for this lake's rebuild.
        buildDataLakeMembershipQuery(scope, {
          deletedAt: null,
          archivedAt: null,
          $or: [
            { notes: { $in: [...CONVERGENCE_PAUSED_NOTES] } },
            // `error` empty on this arm, unlike the note arm where it is empty by construction: a
            // rebuild that failed TERMINALLY keeps its stamp, and re-driving it would repeat the
            // same deterministic failure every wave. Those files are reported by
            // countFailedFilesByScope instead, which is the split this door already relies on.
            {
              chunkRebuildRequestedAt: { $lt: new Date(Date.now() - REBUILD_PENDING_STALE_MS) },
              error: { $in: [null, ''] },
            },
          ],
          // Keeps a REPAIRED file out of the wave. `$not: {$gt: 0}` deliberately also matches a null
          // or absent count, so a legacy file carrying the marker is offered the repair rather than
          // silently skipped. commitFabFileChunks clearing the marker is the primary guard; this is
          // what holds if a marker is ever left behind.
          vectorizedChunkCount: { $not: { $gt: 0 } },
          isChunking: { $ne: true },
        }),
        { _id: 1, userId: 1 }
      )
      .lean();
    return docs.map(d => ({ id: d._id.toString(), userId: String(d.userId) }));
  }

  async resetChunkStateByIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    // The ONE reset shape for re-chunking, shared by the bulk "Rebuild passages" wave and the
    // per-file reprocess route, so the two cannot drift on which fields they clear.
    //
    // `isChunking: {$ne: true}` is a REQUIRED precondition, not a claim. The reset writes
    // isChunking:false, so without it a reset lands on a file a worker is actively chunking and
    // RELEASES that worker's lease - which is strictly worse than not claiming, because the freed
    // file can then be acquired by a second worker while the first is still inside chunkFabfile's
    // unconditional delete-then-insert. Per-document atomicity makes this race-free: a file that
    // raced to isChunking:true after selection is simply not reset, and its stray enqueue then
    // correctly LOSES the worker CAS instead of racing it.
    //
    // Returns the ids actually reset - never the input set - so the caller enqueues exactly what it
    // changed and its reported count cannot overstate the work.
    //
    // `error` MUST be cleared with the rest. A file that chunked then FAILED vectorization carries a
    // non-empty error with chunked:true, and detection doesn't check error, so it can land in a wave.
    // Leaving it set would strand the file: chunked:false + a stale error is invisible to both
    // re-detection (needs chunked:true) and the rescue sweep (needs empty error).
    //
    // Batched rather than one Promise.all over the whole wave: maxPoolSize defaults to 2
    // (b4m-core/db-core/src/utils/mongo.ts), so fanning 200 findOneAndUpdates out at once just
    // queues 198 of them, and on self-host - one long-lived process sharing that pool with every
    // other request - it stalls unrelated queries for the length of the wave. Purely a scheduling
    // bound: the per-document precondition and the exact returned-id set are unchanged.
    const results: (string | null)[] = [];
    for (let i = 0; i < ids.length; i += RESET_CONCURRENCY) {
      const batch = await Promise.all(
        ids.slice(i, i + RESET_CONCURRENCY).map(async id => {
          const doc = await this.fabFileModel.findOneAndUpdate(
            { _id: id, isChunking: { $ne: true } },
            {
              $set: {
                isChunking: false,
                chunked: false,
                chunkCount: 0,
                vectorized: false,
                vectorizedChunkCount: 0,
                notes: '',
                error: null,
                // The four lake-health rollups go with the rest. They describe chunks this reset is
                // about to invalidate, and the PR that added them states the rule for exactly this
                // case (FAB_FILE_CONTENT_REWRITE_PATCH, and chunk.ts's rewrite path). Harmless today
                // only because chunkCount:0 drops the row at the health aggregate's $match - which is
                // an accident of another filter, not something this method should rely on.
                chunkedCharCount: null,
                maxChunkCharLength: null,
                embeddedChunkCount: null,
                embeddedCharCount: null,
                // A stale readiness stamp would make the Atlas cutover read path treat the file as
                // ANN-ready before its new chunks are re-stamped (see vectorSearchEligibility.ts).
                chunkEmbeddingModelStampedAt: null,
                // The whole point of doing this in ONE write (#1939). Everything above takes the
                // file's passages away on paper; this is what says so. Without it the gap between
                // this reset and the caller's queue send carries no marker at all, and a producer
                // that dies in that gap - or a consumer whose own marker write is lost - leaves a
                // chunkless, error-less, note-less file that health, convergence, the retrieval
                // withhold and the rebuild door all read as an image.
                chunkRebuildRequestedAt: new Date(),
              },
            }
          );
          return doc ? id : null;
        })
      );
      results.push(...batch);
    }
    return results.filter((id): id is string => id !== null);
  }

  async countFailedFilesByScope(scope: DataLakeMembershipScope): Promise<number> {
    // Files whose re-chunk gave up (error set, no chunks). They are invisible to both
    // findChunkedFilesByScope (needs chunked:true) and the rescue sweep (needs empty error), so the
    // rebuild badge would read zero for them; surfaced separately so a manager can tell "done" from
    // "some files failed and won't retry on their own". `status:{$ne:'pending'}` mirrors
    // computeDataLakeStats: a still-uploading file isn't a failed re-chunk.
    return this.fabFileModel.countDocuments({
      ...buildDataLakeMembershipFilter(scope),
      deletedAt: null,
      archivedAt: null,
      status: { $ne: 'pending' },
      chunkCount: { $lte: 0 },
      error: { $nin: [null, ''] },
    });
  }

  /**
   * Per-lake live file counts, keyed by membership tag. A lake with no members counts 0 rather
   * than dropping out of the map.
   *
   * Batched into `$facet` aggregates rather than one `countDocuments` per scope: the tag-count
   * surface hands this every lake an ADMIN can see - every lake of every tenant - and a fan-out
   * that wide is thousands of round trips through a pool that defaults to two connections
   * (b4m-core/db-core/src/utils/mongo.ts), which is what times the request out.
   *
   * Each facet branch re-applies its OWN scope filter to the chunk's union, so the counts stay
   * per-scope INDEPENDENT: a file that belongs to two lakes (co-owned meta-tags, or a colliding
   * prefix) counts once for each, exactly as the per-scope counts did. A `$group` on a single
   * matched lake would have undercounted it.
   *
   * Chunks run at LAKE_COUNT_CONCURRENCY, the same bound countDataLakeUniqueFilesByPrefix uses:
   * these two legs are issued concurrently with each other, so neither may fan out freely.
   */
  async countDataLakeFilesByMembership(scopes: DataLakeMembershipScope[]): Promise<Record<string, number>> {
    if (scopes.length === 0) return {};
    const counts: Record<string, number> = {};
    const chunkStarts = Array.from(
      { length: Math.ceil(scopes.length / LAKE_COUNT_CHUNK) },
      (_, i) => i * LAKE_COUNT_CHUNK
    );
    await mapBounded(chunkStarts, LAKE_COUNT_CONCURRENCY, async i => {
      const chunk = scopes.slice(i, i + LAKE_COUNT_CHUNK);
      const filters = chunk.map(scope => ({
        ...buildDataLakeMembershipFilter(scope),
        deletedAt: null,
        archivedAt: null,
        status: { $ne: 'pending' },
      }));
      // Synthetic branch keys: a facet field name may not contain a '.' or start with a '$',
      // and `datalakeTag` is a user-derived string. Mapped back positionally.
      const [row] = await this.fabFileModel.aggregate<Record<string, { n: number }[]>>([
        { $match: { $or: filters } },
        { $facet: Object.fromEntries(filters.map((filter, j) => [`s${j}`, [{ $match: filter }, { $count: 'n' }]])) },
      ]);
      chunk.forEach((scope, j) => {
        counts[scope.datalakeTag] = row?.[`s${j}`]?.[0]?.n ?? 0;
      });
    });
    return counts;
  }

  // The delete/restore pair below is stamp-keyed. Phase-1 delete passes `at` to write one shared
  // stamp across every row it flips, records that value on the lake, and restore passes it back as
  // `stampedAt` to reverse exactly that batch. Equality, not a range: a lower bound would also match
  // a file the creator deleted DURING the deleted window (the per-file delete routes stamp
  // `deletedAt` too), and those deletions are the creator's to keep, not the teardown's to reverse.
  // Omitting `stampedAt` matches every stamped row, which is the pre-mark behavior and the fallback
  // for a lake torn down before the mark existed.
  //
  // The archive axis is stamped the same way (`at`, from `IDataLake.filesArchivedAt`), because
  // restore now also clears `archivedAt` (an archive->delete->restore must not leave files
  // archived-and-invisible) - so equality-bounding that clear against the stamp is what stops it
  // from freeing a prefix-sharing sibling's independently-archived files, the same way the delete
  // axis avoids reviving a file the creator deleted on their own. `unarchiveByDataLakeTag` and
  // `findArchivedByDataLakeTag` bound themselves the same way, over the WHOLE membership filter -
  // a meta-tag match is not exempt: `addFileToLake` lets one file carry more than one lake's
  // meta-tag with no exclusivity check, so a meta-tagged row can just as easily belong to a
  // co-owning lake's own archive as a prefix-tagged row can belong to a sibling's.

  async archiveByDataLakeTag(scope: DataLakeMembershipScope, at: Date = new Date()): Promise<number> {
    const result = await this.fabFileModel.updateMany(
      { ...buildDataLakeMembershipFilter(scope), deletedAt: null, archivedAt: null },
      { $set: { archivedAt: at } }
    );
    return result.modifiedCount;
  }

  async unarchiveByDataLakeTag(scope: DataLakeMembershipScope, stampedAt?: Date): Promise<number> {
    const result = await this.fabFileModel.updateMany(
      { ...buildDataLakeMembershipFilter(scope), deletedAt: null, archivedAt: stampedAt ?? { $ne: null } },
      { $set: { archivedAt: null } }
    );
    return result.modifiedCount;
  }

  // `stampedAt` narrows the dedup read the same way it narrows the reversal above - omitting it
  // (a lake with no recorded stamp) matches every archived row, same as before this parameter
  // existed. Without this, the dedup pass could read a co-owning or sibling lake's own archived
  // member and, if it happens to share a contentHash with one of THIS lake's live files,
  // soft-delete that other lake's row as a "duplicate" it never owned.
  async findArchivedByDataLakeTag(scope: DataLakeMembershipScope, stampedAt?: Date): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({
      ...buildDataLakeMembershipFilter(scope),
      deletedAt: null,
      archivedAt: stampedAt ?? { $ne: null },
    });
    return result.map(d => d.toJSON());
  }

  // Unbounded existence probe, deliberately with no `stampedAt` param unlike
  // findArchivedByDataLakeTag above - its one caller (archiveDataLake's hasUnstampedArchive
  // guard) needs to know whether ANY member is already archived, stamped or not, to decide
  // whether claiming a fresh stamp would strand a pre-existing one; scoping it by a stamp that
  // does not exist yet would defeat the check.
  //
  // EXCLUSIVE to this lake's own meta-tag: a row also carrying another lake's meta-tag is that
  // lake's under that lake's own stamp, not this lake's orphan (addFileToLake has no exclusivity
  // check, so one file can carry more than one lake's tag). Counting it here would make this
  // lake skip claiming its own stamp, stay permanently unstamped, and fall back to the pre-fix
  // unbounded restore on every one of its OWN future unarchive calls - freeing the co-owner's
  // legitimately-archived row. Says nothing about a prefix-ARM collision, which carries no lake
  // attribution at all and remains a known, accepted limitation (#1729).
  async hasArchivedMemberExclusiveToDataLakeTag(scope: DataLakeMembershipScope): Promise<boolean> {
    return (
      (await this.fabFileModel.exists({
        ...buildDataLakeMembershipFilter(scope),
        ...buildNoOtherLakeMetaTagFilter(scope.datalakeTag),
        deletedAt: null,
        archivedAt: { $ne: null },
      })) != null
    );
  }

  async findDeletedByDataLakeTag(scope: DataLakeMembershipScope, stampedAt?: Date): Promise<IFabFileDocument[]> {
    // `includeDeleted` is load-bearing for BOTH forms, not just tidiness: the soft-delete plugin's
    // find hook does `this.where({ deletedAt: null })`, which REPLACES the condition on that key, so
    // without the option this query silently returns nothing.
    const result = await this.fabFileModel
      .find({ ...buildDataLakeMembershipFilter(scope), deletedAt: stampedAt ?? { $ne: null } })
      .setOptions({ includeDeleted: true });
    return result.map(d => d.toJSON());
  }

  async undeleteByDataLakeTag(
    scope: DataLakeMembershipScope,
    excludeIds: string[] = [],
    stampedAt?: Date,
    archiveStampToClear?: Date
  ): Promise<number> {
    const base: Record<string, unknown> = {
      ...buildDataLakeMembershipFilter(scope),
      deletedAt: stampedAt ?? { $ne: null },
    };
    if (excludeIds.length > 0) base._id = { $nin: excludeIds };

    if (!archiveStampToClear) {
      const result = await this.fabFileModel.updateMany(base, { $set: { deletedAt: null } });
      return result.modifiedCount;
    }

    // Two parallel queries partitioned on `archivedAt`, not one update followed by another - not
    // for snapshot isolation (Mongo gives none across separate updateMany calls), but because the
    // shared `deletedAt: stampedAt` base filter is a barrier: once either query flips a row's
    // `deletedAt` to null, that row no longer matches EITHER filter, so it cannot be picked up
    // twice. A row stamped by THIS lake's own archive gets both fields cleared; any other value (a
    // different lake's stamp, or none) only un-deletes, leaving its archive marker exactly as it
    // was - the equality bound that keeps this from freeing a prefix-sharing sibling's
    // independently-archived files.
    const [ownStamp, otherStamp] = await Promise.all([
      this.fabFileModel.updateMany(
        { ...base, archivedAt: archiveStampToClear },
        { $set: { deletedAt: null, archivedAt: null } }
      ),
      this.fabFileModel.updateMany(
        { ...base, archivedAt: { $ne: archiveStampToClear } },
        { $set: { deletedAt: null } }
      ),
    ]);
    return ownStamp.modifiedCount + otherStamp.modifiedCount;
  }

  async softDeleteByDataLakeTag(scope: DataLakeMembershipScope, at: Date = new Date()): Promise<string[]> {
    const docs = await this.fabFileModel.find({ ...buildDataLakeMembershipFilter(scope), deletedAt: null }, { _id: 1 });
    const ids = docs.map(d => d._id.toString());
    if (ids.length === 0) return [];
    await this.fabFileModel.updateMany({ _id: { $in: ids } }, { $set: { deletedAt: at } });
    return ids;
  }

  async hardDeleteByIds(fabFileIds: string[]): Promise<string[]> {
    if (fabFileIds.length === 0) return [];
    // hardDelete bypasses the soft-delete plugin's deleteMany override (phase-2 purge).
    await this.fabFileModel.deleteMany({ _id: { $in: fabFileIds } }, { hardDelete: true } as Record<string, unknown>);
    return fabFileIds;
  }

  async hardDeleteByDataLakeTag(scope: DataLakeMembershipScope): Promise<string[]> {
    // Include soft-deleted files: the phase-2 sweep must purge every member.
    const docs = await this.fabFileModel
      .find(buildDataLakeMembershipFilter(scope), { _id: 1 })
      .setOptions({ includeDeleted: true });
    return this.hardDeleteByIds(docs.map(d => d._id.toString()));
  }

  async findIdsByDataLakeTag(scope: DataLakeMembershipScope): Promise<string[]> {
    const docs = await this.fabFileModel
      .find(buildDataLakeMembershipFilter(scope), { _id: 1 })
      .setOptions({ includeDeleted: true });
    return docs.map(d => d._id.toString());
  }

  async updateTagsByUserId(userId: string, tag: string, newTag: string): Promise<number> {
    if (!tag || !newTag) return 0;
    // Anchored and escaped for the same reason as removeTagByUserId: unanchored, renaming `q1`
    // also rewrote `q1-draft`.
    const nameRegex = new RegExp(`^${escapeRegex(tag)}$`, 'i');
    // `$[elem]` and not `$`: the first-positional operator updates only the FIRST matching element
    // per document, so a file carrying the name twice kept one stale copy.
    // No deletedAt conjunct - see removeTagByUserId; an undelete must not revive the old name.
    const result = await this.fabFileModel.updateMany(
      {
        userId,
        'tags.name': nameRegex,
      },
      {
        $set: {
          'tags.$[elem].name': newTag,
        },
      },
      { arrayFilters: [{ 'elem.name': nameRegex }] }
    );
    // Renamed rather than cleared: unlike a delete, the tag still exists under its new name, so
    // the file's primary label should follow it.
    await this.fabFileModel.updateMany({ userId, primaryTag: nameRegex }, { $set: { primaryTag: newTag } });
    return result.modifiedCount;
  }

  async dedupeTagByUserId(userId: string, name: string): Promise<number> {
    if (!name) return 0;
    const folded = name.toLowerCase();
    // An aggregation-pipeline update, which is NOT the read-modify-write that pullTagsByFabFileId
    // rejects: the array is rebuilt from the document's own value server-side inside one atomic
    // per-document write, so there is no snapshot round trip for a concurrent writer to lose.
    // Same mechanism as StockPortfolioRepository.executeBuy.
    //
    // `$ifNull` guards throughout: `tags` is declared as [Object] with no sub-schema, and legacy
    // rows carry elements with a missing or non-string `name` - six other call sites defend the
    // same shape. Without the guard one bad element decides the whole user's dedupe.
    const isMatch = (expr: unknown) => ({ $eq: [{ $toLower: { $ifNull: [expr, ''] } }, folded] });
    const result = await this.fabFileModel.updateMany(
      {
        userId,
        // Index-eligible prefilter first, then the $expr narrows to documents that genuinely carry
        // the name more than once, so the write set stays small.
        'tags.name': new RegExp(`^${escapeRegex(name)}$`, 'i'),
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $ifNull: ['$tags', []] },
                  as: 't',
                  cond: isMatch('$$t.name'),
                },
              },
            },
            1,
          ],
        },
      },
      [
        {
          $set: {
            tags: {
              $reduce: {
                input: { $ifNull: ['$tags', []] },
                initialValue: [],
                in: {
                  $cond: {
                    if: isMatch('$$this.name'),
                    // Keep the FIRST match, normalized to the passed casing, and drop later ones.
                    // $mergeObjects rather than a rebuilt {name, strength} so `strength` and any
                    // field this schema does not declare survive.
                    then: {
                      $cond: {
                        if: {
                          $anyElementTrue: {
                            $map: { input: '$$value', as: 'kept', in: isMatch('$$kept.name') },
                          },
                        },
                        then: '$$value',
                        else: { $concatArrays: ['$$value', [{ $mergeObjects: ['$$this', { name }] }]] },
                      },
                    },
                    else: { $concatArrays: ['$$value', ['$$this']] },
                  },
                },
              },
            },
          },
        },
      ]
    );
    return result.modifiedCount;
  }

  async pushTagsByFabFileId(fabFileId: string, tagNames: string[], strength = 0): Promise<number> {
    // Skip the round trip: the batch caller hits this whenever a file has nothing to add.
    if (tagNames.length === 0) return 0;
    // Each filter below is evaluated against the STORED document, not against the other ops, so
    // a name repeated within one call would otherwise pass its filter twice and insert twice.
    const names = [...new Set(tagNames)];
    // One filtered $push per name, the atomic counterpart to the $pull above. Not $addToSet:
    // it dedupes on whole-element equality, so { name: 'x', strength: 1 } would land alongside
    // an existing { name: 'x', strength: 0 }. Not a single $each push either - that has no
    // per-element guard, so one already-present name either poisons the batch or duplicates.
    const result = await this.fabFileModel.bulkWrite(
      names.map(name => ({
        updateOne: {
          // Exact names, mirroring the $pull above and the read path, which matches a tag by
          // exact `$in`. A case-insensitive guard here would be actively wrong: a file carrying
          // some other casing of a data-lake meta-tag is NOT a member of that lake, so the
          // canonical tag has to be insertable alongside it.
          filter: { _id: fabFileId, 'tags.name': { $ne: name } },
          update: { $push: { tags: { name, strength } } },
        },
      }))
    );
    return result.modifiedCount;
  }

  async pullTagsByFabFileId(fabFileId: string, tagNames: string[]): Promise<number> {
    // The schema has timestamps, so an empty $in would still rewrite updatedAt and report a
    // modification for a write that removes nothing.
    if (tagNames.length === 0) return 0;
    // Atomic $pull by exact tag names: removes only the matching elements, so concurrent
    // removals of different tags on the same file can't clobber each other. Idempotent -
    // absent names are a no-op. Exact names only, deliberately: a prefix pattern here would
    // mean building a regex from a user-chosen prefix, and an empty one matches every tag.
    const result = await this.fabFileModel.updateOne(
      { _id: fabFileId },
      { $pull: { tags: { name: { $in: tagNames } } } }
    );
    // A primaryTag naming a tag the file no longer carries later fails the data-lake write
    // gate on PUT /api/files/[id], which round-trips the stale value. Separate filtered write
    // because a plain update can't clear a field conditionally on its own value; it is a
    // no-op unless primaryTag actually went.
    // Deliberately NOT folded into the $pull above: an aggregation-pipeline update could do both
    // in one write, but only by rewriting the whole tags array, which loses the element-level
    // concurrency $pull buys. The cost of two writes is that a crash between them leaves a
    // primaryTag pointing at a removed tag, which the gate above then rejects until it is set
    // again. A stale label that blocks one edit beats a lost concurrent removal.
    await this.fabFileModel.updateOne(
      { _id: fabFileId, primaryTag: { $in: tagNames } },
      { $unset: { primaryTag: '' } }
    );
    return result.modifiedCount;
  }
}

// Non-destructive AI-edit history for binary Office documents. `_id: false` keeps entries
// as plain sub-objects (they are addressed by `version`, not ObjectId).
const FabFileVersionSchema = new Schema<IFabFileVersion>(
  {
    version: { type: Number, required: true },
    filePath: { type: String, required: true },
    fileSize: { type: Number },
    mimeType: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const FabFileSchema = new Schema<IFabFileDocument, IFabFileModel>(
  {
    userId: { type: String, required: true },
    fileName: { type: String, required: true },
    fileSize: { type: Number },
    // Extracted TEXT length, not bytes; see IFabFile. Absent until something extracts the file.
    extractedCharCount: { type: Number, required: false },
    filePath: { type: String },
    mimeType: { type: String },
    type: { type: String, enum: Object.values(KnowledgeType), required: true },

    chunkCount: { type: Number, default: 0 },
    vectorizedChunkCount: { type: Number, default: 0 },
    // Sum of the file's chunks' charLength; nulled on content rewrite. See IFabFile.chunkedCharCount.
    chunkedCharCount: { type: Number, required: false },
    // Lake-health (#1666) per-file rollups. Deliberately NOT `default: 0` - absent must read as
    // UNMEASURED (backfill has not reached this file), distinct from a measured 0. See IFabFile.
    maxChunkCharLength: { type: Number, required: false },
    embeddedChunkCount: { type: Number, required: false },
    embeddedCharCount: { type: Number, required: false },

    isChunking: { type: Boolean, default: false },
    // When isChunking was last set true - always worker pickup, the only writer. Lets the
    // rescue sweep recover a claim stranded by a hard worker crash (OOM/timeout/deploy) that never
    // ran the finally - see buildFabFileChunkScanFilter's stale-claim arm.
    chunkClaimedAt: { type: Date, default: null },
    // Written by confirmChunkClaim on every matched call - see IFabFileRepository.confirmChunkClaim
    // for why this field exists at all: it exists ONLY so that write is never a byte-for-byte
    // no-op. Purely diagnostic otherwise; nothing reads it.
    chunkClaimConfirmedAt: { type: Date, default: null },
    chunked: { type: Boolean, default: false },
    // Chunk policy at file-owner altitude (#1662). chunkedPassageTokenTarget: the effective target
    // (post model-window clamp) the current chunks were built with, so a later lake-membership
    // change can check a lake's requirement without re-chunking. chunkPolicyConflict: the cross-lake
    // conflict report (Mixed, like sourceMetadata; null when no conflict). A report, not a failure -
    // the file stays chunked at its owner-altitude policy.
    chunkedPassageTokenTarget: { type: Number, required: false },
    chunkPolicyConflict: { type: Schema.Types.Mixed, required: false, default: null },
    // Stamped by resetChunkStateByIds in the same write that clears the rollups, so the state a
    // rebuild creates is never unmarked (#1939). See IFabFile.chunkRebuildRequestedAt.
    chunkRebuildRequestedAt: { type: Date, default: null },
    isVectorizing: { type: Boolean, default: false },
    vectorized: { type: Boolean, default: false },
    embeddingModel: { type: String, required: false },
    chunkEmbeddingModelStampedAt: { type: Date, required: false },

    system: { type: Boolean, default: false },
    systemPriority: { type: Number, default: 999 },
    tags: { type: [Object], default: [] },
    primaryTag: { type: String, required: false },
    status: {
      type: String,
      enum: ['pending', 'complete'] as const,
      default: 'pending',
    },
    moderationStatus: {
      type: String,
      enum: ['pending', 'scanning', 'clean', 'blocked'] as const,
      default: 'pending',
    },
    // Set only when moderationStatus === 'blocked'. Distinguishes a
    // confirmed-explicit match from a format the scanner structurally couldn't process
    // (e.g. 'unsupported_format'), so ops can tell the two apart without CloudWatch.
    blockReason: { type: String, required: false },
    error: { type: String, required: false },
    presignedUrl: { type: String },
    fileUrl: { type: String },
    fileUrlExpireAt: { type: Date },
    sessionId: { type: String, required: false },
    notes: { type: String, default: '' },
    contentHash: { type: String },
    // Server-verified SHA-256 over normalized extracted text, stamped by the admission contract at
    // chunk time (see IFabFile.serverTextHash). The trustworthy dedup input for #1671, distinct from
    // the client-supplied byte hash in `contentHash`.
    serverTextHash: { type: String },
    batchId: { type: String },
    relativePath: { type: String },
    // Provenance. Declared because strict mode drops undeclared paths silently: `sourceType` was
    // already being written by the Slack file intake and discarded on every save, so anything
    // reading it back saw MANUAL_UPLOAD-shaped nothing. Free-form `sourceMetadata` carries the
    // per-source origin (for Slack: channel + message ts) that makes an ingested file auditable.
    sourceType: { type: String, enum: Object.values(FabFileSourceType), required: false },
    sourceMetadata: { type: Schema.Types.Mixed, required: false },
    // Google Drive ingest provenance (#1589). Populated when sourceType === GOOGLE_DRIVE.
    driveFileId: { type: String },
    driveModifiedTime: { type: Date },
    driveMd5Checksum: { type: String },
    sourceLakeId: { type: String },
    driveConnectionId: { type: String },
    archivedAt: { type: Date },
    // Absent until the first AI edit of a docx/xlsx; each edit appends an entry.
    versions: { type: [FabFileVersionSchema], default: undefined },

    ...ShareableDocumentSchema,
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: {
      virtuals: true,
      transform: function (doc, ret: any) {
        // If fileType is PDF, remove content from the response
        if (ret.mimeType === 'application/pdf') {
          delete ret.content;
        }
      },
    },
    toObject: {
      virtuals: true,
    },
  }
);

FabFileSchema.plugin(softDeletePlugin);

// Add critical FabFiles indexes for performance optimization
FabFileSchema.index({ isChunk: 1, userId: 1 });
FabFileSchema.index({ deletedAt: 1, userId: 1, sessionId: 1, createdAt: 1 });
FabFileSchema.index({ deletedAt: 1, sessionId: 1, createdAt: 1, userId: 1 });
FabFileSchema.index({ deletedAt: 1, userId: 1, sessionId: 1, createdAt: -1 });
FabFileSchema.index({ deletedAt: 1, userId: 1, createdAt: 1 });
FabFileSchema.index({ deletedAt: 1, userId: 1, createdAt: -1 });
FabFileSchema.index({ deletedAt: 1, createdAt: -1, userId: 1 });
FabFileSchema.index({ deletedAt: 1, filePath: 1 });

// Optimize permission and sharing queries
FabFileSchema.index({ isChunk: 1, 'users.permissions': 1, 'users.userId': 1 });

// Optimize global access patterns
FabFileSchema.index({ isChunk: 1, isGlobalRead: 1 });

// Group permission indexes
FabFileSchema.index({ deletedAt: 1, 'groups.groupId': 1, 'groups.permissions': 1 });

// Optimized index for searchCollections query - fabfiles collection
FabFileSchema.index({ userId: 1, deletedAt: 1, fileName: 'text', updatedAt: -1 });

// Data lake tag-based access + lifecycle queries (archive/delete/stat-recompute scoped by
// meta-tag). The leading `tags.name` prefix also serves the plain tag-access lookups, so no
// separate single-field `{ 'tags.name': 1 }` index is needed (dropped in a migration).
FabFileSchema.index({ 'tags.name': 1, archivedAt: 1, deletedAt: 1 });

// Bounds the prefix arm of buildDataLakeMembershipFilter (see computeDataLakeStats above): that
// query's userId conjunct is not covered by the index above, so without this one Mongo scans the
// tag-prefix range across every user before filtering userId in memory.
//
// `tags.name` leads over `archivedAt`/`deletedAt` (not strict equality-sort-range order) because
// some callers of buildDataLakeMembershipFilter - findIdsByDataLakeTag, hardDeleteByDataLakeTag -
// filter on nothing but this predicate, with no archivedAt/deletedAt condition at all; putting
// those two ahead of tags.name would leave this index unable to bound the tag range for those
// callers, only the userId equality.
FabFileSchema.index({ userId: 1, 'tags.name': 1, archivedAt: 1, deletedAt: 1 });

// Content hash deduplication lookups
FabFileSchema.index({ contentHash: 1, userId: 1 });

// Acquisition dedup (#1671): findByServerTextHashesInDataLake, an $in over the hash bounded by the
// lake's meta-tag. Deferred from #1679 until this reader existed - the field had no consumer then.
// Hash-first, not tag-first: the hash is by far the more selective of the two, and `tags.name` is a
// multikey path that the other lake indexes already lead on.
FabFileSchema.index({ serverTextHash: 1 });

// Google Drive ingest dedup (driveFileId is the stable re-sync key; contentHash changes on edit)
FabFileSchema.index({ driveFileId: 1 });

// Drive re-sync reconcile: findByDriveConnectionIdInDataLake runs on every poll. Compound rather
// than a bare { driveConnectionId: 1 }, which is an equality prefix only - that leaves the planner
// fetching every historical row for a connection and post-filtering the rest of the predicate. The
// three equality keys the query also carries bound it to the live rows in the index itself
// (archivedAt and tags.name stay post-filters; a multikey array key here would not help).
FabFileSchema.index({ driveConnectionId: 1, deletedAt: 1, status: 1 });

// Un-chunked rescue sweep (buildFabFileChunkScanFilter: self-host worker scan + the hosted
// dataLakeBatchReconcile cron). Equality prefix, createdAt range last; without it the daily
// sweep is a collection scan, since almost every file has chunkCount > 0.
FabFileSchema.index({ status: 1, chunkCount: 1, deletedAt: 1, createdAt: 1 });

// Batch file queries
FabFileSchema.index({ batchId: 1 });

// Moderation queue / audit lookups
FabFileSchema.index({ userId: 1, moderationStatus: 1 });

FabFileSchema.plugin(addLowercaseField, { fields: ['fileName'] });

export const FabFile =
  (mongoose.models.FabFile as unknown as IFabFileModel) ??
  mongoose.model<IFabFileDocument, IFabFileModel>('FabFile', FabFileSchema);
export default FabFile;

export const fabFileRepository = new FabFileRepository(FabFile, {
  shareable: new ShareableDocumentRepository(FabFile),
});
