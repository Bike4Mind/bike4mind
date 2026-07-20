import {
  IFabFileChunkDocument,
  IFabFileChunkRepository,
  IFabFileDocument,
  IFabFileRepository,
  IFabFileVersion,
  KnowledgeType,
} from '@bike4mind/common';
import mongoose, { Model, Schema } from 'mongoose';
import { convertIds, softDeletePlugin } from '../../utils/mongo';
import BaseRepository from '@bike4mind/db-core';
import { addLowercaseField } from '../../utils/documentdb-compat';
import { ShareableDocumentRepository, ShareableDocumentSchema } from './SharableDocumentModel';
import { buildFabFileSearchQuery, buildOwnershipConditions, escapeRegex } from '../../queries/fabFileSearchQuery';

interface IFabFileChunkModel extends Model<IFabFileChunkDocument> {}

export interface IFabFileModel extends Model<IFabFileDocument> {}

export class FabFileChunkRepository extends BaseRepository<IFabFileChunkDocument> implements IFabFileChunkRepository {
  constructor(private fabFileChunkModel: IFabFileChunkModel) {
    super(fabFileChunkModel);
  }

  async deleteManyByFabFileId(fabFileId: string) {
    await this.fabFileChunkModel.deleteMany({ fabFileId });
  }

  async bulkInsert(chunks: Omit<IFabFileChunkDocument, 'id'>[]) {
    const result = await this.fabFileChunkModel.insertMany(chunks);

    return result.map(d => d.toJSON());
  }

  async findByFabFileId(fabFileId: string) {
    return this.fabFileChunkModel.find({ fabFileId });
  }

  /**
   * Bulk-fetch vector-bearing chunks for many files in ONE indexed query (uses the
   * `fabFileId` index, filters out vectorless chunks at the DB layer, projects only the
   * fields semantic search needs, and caps total rows for Lambda memory safety). Mirrors
   * the query previously inlined in /api/opti/semantic-search so the shared service can run
   * in-process. `.lean()` skips Mongoose hydration - cheap for thousands of chunks.
   */
  async findVectorsByFabFileIds(fabFileIds: string[], cap = 10_000) {
    const docs = await this.fabFileChunkModel
      .find({ fabFileId: { $in: fabFileIds }, vector: { $exists: true, $ne: [] } })
      .select({ _id: 1, fabFileId: 1, text: 1, vector: 1 })
      .limit(cap)
      .lean();
    return docs.map(d => ({
      id: String(d._id),
      fabFileId: String(d.fabFileId),
      text: d.text ?? '',
      vector: (d.vector as number[]) ?? [],
    }));
  }

  /**
   * Count a file's "terminal" chunks: those that have an embedding vector OR are
   * oversized (token count exceeds the model context window, so they can never be
   * embedded). Used to recompute vectorizedChunkCount from source so SQS redelivery
   * of a partial-batch message is idempotent (no += double-counting).
   */
  async countTerminalChunks(fabFileId: string, contextWindow: number): Promise<number> {
    return this.fabFileChunkModel.countDocuments({
      fabFileId,
      $or: [{ 'vector.0': { $exists: true } }, { tokenCount: { $gt: contextWindow } }],
    });
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
    vector: { type: [Number], required: false },
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

FabFileChunkSchema.index({ _id: 1, fabFileId: 1 });
FabFileChunkSchema.index({ fabFileId: 1 });

export const FabFileChunk =
  (mongoose.models.FabFileChunk as IFabFileChunkModel) ??
  mongoose.model<IFabFileChunkDocument, IFabFileChunkModel>('FabFileChunk', FabFileChunkSchema);

export const fabFileChunkRepository = new FabFileChunkRepository(FabFileChunk);

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
      type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code';
      shared?: boolean;
      curated?: boolean;
      fileIds?: string[];
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
      excludeContent?: boolean;
      excludeFilenameMarkers?: string[];
      vectorizedOnly?: boolean;
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

  async countByUserIdAndTag(userId: string, tag: string): Promise<number> {
    const result = await this.fabFileModel.countDocuments({
      userId,
      deletedAt: null,
      tags: {
        $elemMatch: {
          name: { $regex: new RegExp(tag, 'i') },
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
    }
  ): Promise<{ tag: string; count: number }[]> {
    // When options are provided, include shared/group/data-lake files.
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
    const ownershipFilter = options ? { $or: buildOwnershipConditions(userId, options) } : { userId };
    const sessionFilter = {
      $or: [
        { sessionId: null },
        { sessionId: { $exists: false } },
        { tags: { $elemMatch: { name: 'curated-notebook' } } },
      ],
    };

    const prefixPattern = tagPrefixes.map(p => escapeRegex(p)).join('|');
    const prefixRegex = new RegExp(`^(${prefixPattern})`);

    const result = await this.fabFileModel.aggregate([
      {
        // Pre-unwind filter: use $elemMatch with the prefix regex so MongoDB can use
        // the tags.name index and skip non-data-lake files entirely before the $unwind
        // stage materializes every tag of every file.
        $match: {
          $and: [ownershipFilter, sessionFilter],
          deletedAt: null,
          tags: { $elemMatch: { name: { $regex: prefixRegex } } },
        },
      },
      { $unwind: '$tags' },
      { $match: { $and: [{ 'tags.name': { $regex: prefixRegex } }, { 'tags.name': { $not: /^datalake:/ } }] } },
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
    // Defense-in-depth: an empty prefix list builds `^()`, which matches every
    // string and would return the user's entire non-deleted scope as the "total".
    // The endpoint already early-returns when no lakes are accessible, but guard
    // here too so a direct caller can't accidentally over-count.
    if (tagPrefixes.length === 0) return { total: 0, byPrefix: {} };

    const ownershipFilter = options ? { $or: buildOwnershipConditions(userId, options) } : { userId };
    const sessionFilter = {
      $or: [
        { sessionId: null },
        { sessionId: { $exists: false } },
        { tags: { $elemMatch: { name: 'curated-notebook' } } },
      ],
    };
    const baseMatch = { $and: [ownershipFilter, sessionFilter], deletedAt: null };

    // One indexed countDocuments per prefix (few lakes), plus one for the combined total.
    // $elemMatch on the anchored prefix regex lets MongoDB use the tags.name index and
    // counts each file once regardless of how many matching tags it carries.
    const anyPrefixRegex = new RegExp(`^(${tagPrefixes.map(p => escapeRegex(p)).join('|')})`);
    const [total, ...prefixCounts] = await Promise.all([
      this.fabFileModel.countDocuments({ ...baseMatch, tags: { $elemMatch: { name: { $regex: anyPrefixRegex } } } }),
      ...tagPrefixes.map(prefix =>
        this.fabFileModel.countDocuments({
          ...baseMatch,
          tags: { $elemMatch: { name: { $regex: new RegExp(`^${escapeRegex(prefix)}`) } } },
        })
      ),
    ]);

    const byPrefix: Record<string, number> = {};
    tagPrefixes.forEach((prefix, i) => {
      byPrefix[prefix] = prefixCounts[i];
    });
    return { total, byPrefix };
  }

  async countUniqueFilesByNamespaceForUser(userId: string): Promise<{ namespace: string; fileCount: number }[]> {
    const result = await this.fabFileModel.aggregate([
      {
        $match: {
          userId,
          deletedAt: null,
          tags: { $exists: true, $ne: [] },
          // Exclude session summaries (unless curated-notebook) to match search behavior
          $or: [
            { sessionId: null },
            { sessionId: { $exists: false } },
            { tags: { $elemMatch: { name: 'curated-notebook' } } },
          ],
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
    const result = await this.fabFileModel.updateMany(
      {
        userId,
        deletedAt: null,
        tags: {
          $elemMatch: {
            name: { $regex: new RegExp(tag, 'i') },
          },
        },
      },
      {
        $pull: {
          tags: {
            name: { $regex: new RegExp(tag, 'i') },
          },
        },
      }
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

  async findByContentHashes(userId: string, hashes: string[]): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({
      userId,
      contentHash: { $in: hashes },
      deletedAt: null,
    });
    return result.map(d => d.toJSON());
  }

  async findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({
      contentHash: { $in: hashes },
      deletedAt: null,
      archivedAt: null,
      tags: { $elemMatch: { name: datalakeTag } },
    });
    return result.map(d => d.toJSON());
  }

  // Data lake lifecycle (scoped by the lake's datalake: meta-tag)

  /**
   * Authoritative lake stats from source records via an indexed aggregate - counts
   * only live files (not archived, not deleted). Runs at batch completion AND on the
   * reconcile read path, so it must NOT load-all-and-count.
   */
  async computeDataLakeStats(datalakeTag: string): Promise<{ fileCount: number; totalSizeBytes: number }> {
    const [agg] = await this.fabFileModel.aggregate<{ fileCount: number; totalSizeBytes: number }>([
      { $match: { 'tags.name': datalakeTag, deletedAt: null, archivedAt: null } },
      { $group: { _id: null, fileCount: { $sum: 1 }, totalSizeBytes: { $sum: { $ifNull: ['$fileSize', 0] } } } },
      { $project: { _id: 0, fileCount: 1, totalSizeBytes: 1 } },
    ]);
    return agg ?? { fileCount: 0, totalSizeBytes: 0 };
  }

  async archiveByDataLakeTag(datalakeTag: string): Promise<number> {
    const result = await this.fabFileModel.updateMany(
      { 'tags.name': datalakeTag, deletedAt: null, archivedAt: null },
      { $set: { archivedAt: new Date() } }
    );
    return result.modifiedCount;
  }

  async unarchiveByDataLakeTag(datalakeTag: string): Promise<number> {
    const result = await this.fabFileModel.updateMany(
      { 'tags.name': datalakeTag, deletedAt: null, archivedAt: { $ne: null } },
      { $set: { archivedAt: null } }
    );
    return result.modifiedCount;
  }

  async findArchivedByDataLakeTag(datalakeTag: string): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel.find({
      'tags.name': datalakeTag,
      deletedAt: null,
      archivedAt: { $ne: null },
    });
    return result.map(d => d.toJSON());
  }

  async findDeletedByDataLakeTag(datalakeTag: string): Promise<IFabFileDocument[]> {
    const result = await this.fabFileModel
      .find({ 'tags.name': datalakeTag, deletedAt: { $ne: null } })
      .setOptions({ includeDeleted: true });
    return result.map(d => d.toJSON());
  }

  async undeleteByDataLakeTag(datalakeTag: string, excludeIds: string[] = []): Promise<number> {
    const filter: Record<string, unknown> = { 'tags.name': datalakeTag, deletedAt: { $ne: null } };
    if (excludeIds.length > 0) filter._id = { $nin: excludeIds };
    const result = await this.fabFileModel.updateMany(filter, { $set: { deletedAt: null } });
    return result.modifiedCount;
  }

  async softDeleteByDataLakeTag(datalakeTag: string): Promise<string[]> {
    const docs = await this.fabFileModel.find({ 'tags.name': datalakeTag, deletedAt: null }, { _id: 1 });
    const ids = docs.map(d => d._id.toString());
    if (ids.length === 0) return [];
    await this.fabFileModel.updateMany({ _id: { $in: ids } }, { $set: { deletedAt: new Date() } });
    return ids;
  }

  async hardDeleteByDataLakeTag(datalakeTag: string): Promise<string[]> {
    // Include soft-deleted files: phase-2 sweep must purge everything carrying the tag.
    const docs = await this.fabFileModel
      .find({ 'tags.name': datalakeTag }, { _id: 1 })
      .setOptions({ includeDeleted: true });
    const ids = docs.map(d => d._id.toString());
    if (ids.length === 0) return [];
    // hardDelete bypasses the soft-delete plugin's deleteMany override (phase-2 purge).
    await this.fabFileModel.deleteMany({ _id: { $in: ids } }, { hardDelete: true } as Record<string, unknown>);
    return ids;
  }

  async findIdsByDataLakeTag(datalakeTag: string): Promise<string[]> {
    const docs = await this.fabFileModel
      .find({ 'tags.name': datalakeTag }, { _id: 1 })
      .setOptions({ includeDeleted: true });
    return docs.map(d => d._id.toString());
  }

  async updateTagsByUserId(userId: string, tag: string, newTag: string): Promise<number> {
    const result = await this.fabFileModel.updateMany(
      {
        userId,
        deletedAt: null,
        'tags.name': { $regex: new RegExp(tag, 'i') },
      },
      {
        $set: {
          'tags.$.name': newTag,
        },
      }
    );
    return result.modifiedCount;
  }

  async pullTagByFabFileId(fabFileId: string, tagName: string): Promise<number> {
    // Atomic $pull by exact tag name: removes only the matching element, so concurrent
    // removals of different tags on the same file can't clobber each other. Idempotent -
    // a no-op (modifiedCount 0) if the tag is already absent.
    const result = await this.fabFileModel.updateOne({ _id: fabFileId }, { $pull: { tags: { name: tagName } } });
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
    filePath: { type: String },
    mimeType: { type: String },
    type: { type: String, enum: Object.values(KnowledgeType), required: true },

    chunkCount: { type: Number, default: 0 },
    vectorizedChunkCount: { type: Number, default: 0 },

    isChunking: { type: Boolean, default: false },
    chunked: { type: Boolean, default: false },
    isVectorizing: { type: Boolean, default: false },
    vectorized: { type: Boolean, default: false },
    embeddingModel: { type: String, required: false },

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
    batchId: { type: String },
    relativePath: { type: String },
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

// Content hash deduplication lookups
FabFileSchema.index({ contentHash: 1, userId: 1 });

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
