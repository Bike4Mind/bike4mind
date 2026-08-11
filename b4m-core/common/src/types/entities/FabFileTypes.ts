import { IBaseRepository, type IMongoDocument } from '.';
import { IShareableStaticMethods, type IShareableDocument } from './ShareableDocumentTypes';

// Define a type for the MIME types
export type MimeType =
  'text/plain' | 'application/pdf' | 'text/csv' | 'application/json' | 'text/markdown' | 'text/html';

export const MimeTypes: MimeType[] = ['text/plain', 'text/markdown', 'application/pdf', 'application/json'];

export enum KnowledgeType {
  /**
   * A knowledge that is from a URL.
   */
  URL = 'URL',
  /**
   * A knowledge that is a file uploaded by the user.
   */
  FILE = 'FILE',
  /**
   * This is a user-created knowledge through the Bike4Mind knowledge editor.
   */
  TEXT = 'TEXT',
  /**
   * Generated audio (TTS / sound effects). Storable and browsable, but never
   * ingestable: no model accepts audio as input, so audio is deliberately
   * excluded from every LLM-attachment and vectorization path.
   */
  AUDIO = 'AUDIO',
}

// Data Lake source types
export enum FabFileSourceType {
  MANUAL_UPLOAD = 'manual_upload',
  SALESFORCE = 'salesforce',
  GOOGLE_DRIVE = 'google_drive',
  SLACK = 'slack',
}

// Data Lake metadata interface
export interface IDataLakeMetadata {
  /** The type of entity this represents (e.g., 'Account', 'Contact', 'Report') */
  entityType: string;
  /** When this file was last synced from the source system */
  lastSyncDate: Date;
  /** The unique identifier in the source system */
  sourceId: string;
  /** Whether this file was processed by the data lake system */
  processedByDataLake: boolean;
  /** Original relative path from folder upload */
  relativePath?: string;
  /** Additional metadata specific to the source type */
  sourceMetadata?: Record<string, unknown>;
}

export interface IFabFileChunk {
  fabFileId: string;
  text: string;
  tokenCount: number;
  vector?: number[];
  /**
   * Embedding model this chunk's vector was generated with. Chunks can outlive their file's
   * current `embeddingModel` (re-embedding, backfill), so this is the per-chunk source of truth
   * an Atlas `$vectorSearch` index lookup keys on - not FabFile.embeddingModel.
   */
  embeddingModel?: string;
}

/**
 * One entry in a FabFile's non-destructive AI-edit history. Each version's bytes live at a
 * distinct S3 key so a prior version is never overwritten. The document's own `filePath`
 * always points at the latest version's bytes.
 */
export interface IFabFileVersion {
  /** 1-based version number, incremented per AI edit. */
  version: number;
  /** S3 key holding this version's bytes. */
  filePath: string;
  fileSize: number;
  mimeType: string;
  createdAt: Date;
}

export interface IFabFileChunkDocument extends IFabFileChunk, IMongoDocument {}

export interface IFabFile {
  userId: string;
  fileName: string;
  /** DocumentDB compatibility: lowercase filename for case-insensitive sorting */
  fileNameLower?: string;

  fileSize: number;
  /**
   * Characters of TEXT this file extracts to, as opposed to its byte size. Absent until something has
   * actually extracted it.
   *
   * The two are only comparable for text/csv/md; a PDF or DOCX of a given byte size can extract to
   * almost any length, which is why a caller wanting to know whether a file fits a model's context
   * cannot infer it from `fileSize`. Written through by the context dry-run route the composer calls,
   * so the second question about the same file is free.
   *
   * Explicitly nullable: an in-place content update sets it to null to invalidate the measurement, and
   * null rather than undefined because the repository's `$set` strips undefined and would leave the
   * stale number in place. Readers must treat null as "not measured", not as zero characters.
   */
  extractedCharCount?: number | null;

  /** This is the path to the file in the storage bucket. Eg: `fab-files/1234.json` */
  filePath?: string;
  mimeType: string;

  /**
   * The organization ID that the file is associated with
   */
  organizationId?: string;

  /** User notes for the file */
  notes?: string;

  /**
   * A FabFile can be a URL, a file uploaded by the user, or a user-created knowledge through the Bike4Mind knowledge editor.
   * @see KnowledgeType
   */
  type: KnowledgeType;

  /** Whether this file should be publicly accessible */
  public?: boolean;

  /** Number of chunks that have been created. */
  chunkCount?: number;
  /** Number of chunks that have been vectorized. */
  vectorizedChunkCount?: number;

  /** Whether this FabFile is currently being chunked. */
  isChunking?: boolean;
  /** Whether this FabFile has been chunked */
  chunked?: boolean;

  /** Whether this FabFile is currently being vectorized. */
  isVectorizing?: boolean;
  /** Whether this FabFile has completed vectorization. */
  vectorized?: boolean;
  /** The embedding model used to generate the vectors. */
  embeddingModel?: string;
  /**
   * When this file's chunks were last fully re-stamped with their per-chunk `embeddingModel`
   * (see IFabFileChunk.embeddingModel). Atlas $vectorSearch cutover treats a stamp younger than
   * ~60s as not-yet-queryable (mongot indexing lag), so this is read-time readiness, not a cache.
   */
  chunkEmbeddingModelStampedAt?: Date | null;

  system?: boolean;

  /**
   * The priority of the system FabFile.
   * This is used to determine the order of the system FabFiles.
   * 0 is the highest priority.
   * 999 is the lowest priority.
   * If the system priority is not set, it will be set to 999.
   * If the system priority is set, it will be used to determine the order of the system FabFiles.
   * The system FabFiles will be sorted by system priority, from highest to lowest.
   * Global System Files have a priority in the range of 0-100.
   * Group and Company System Files have a priority in the range of 101-300.
   * Project System Files have a priority in the range of 301-500.
   * User System Files have a priority in the range of 501-999.
   */
  systemPriority?: number;
  tags?: { name: string; strength: number }[];

  /** Primary tag name used for highlighting in UI */
  primaryTag?: string | null;

  /** Upload status */
  status?: 'pending' | 'complete';

  /**
   * Content-moderation state for an uploaded file. Gates serving via
   * `isImageServeable` for ALL mime types, not just images - see that function's doc
   * comment. 'scanning' is the atomic-claim interim state: a single invocation
   * has claimed the right to scan this file and no other invocation may also scan it.
   */
  moderationStatus?: 'pending' | 'scanning' | 'clean' | 'blocked';

  /**
   * Set only when `moderationStatus === 'blocked'`. Distinguishes a confirmed
   * explicit-content match from a format the scanner structurally couldn't process (e.g.
   * `'unsupported_format'`), so ops can tell the two apart without digging through
   * CloudWatch logs.
   */
  blockReason?: string;

  /**
   * Error message for the file.
   * This is set when the file is not processed successfully, such as when the file is corrupted or unsupported.
   */
  error?: string | null;

  /**
   * Cache the URL of the file for a certain amount of time.
   * to avoid generating new URLs every request.
   */
  fileUrl?: string;
  presignedUrl?: string;
  fileUrlExpireAt?: Date;

  // Data Lake fields
  /** The source where this file originated from */
  sourceType?: FabFileSourceType;
  /**
   * Origin details for the `sourceType`, shaped by that source (for SLACK: the channel id and
   * the message ts the file was posted in). Server-supplied only - never accepted from a request
   * body, or a caller could forge the audit trail this exists to provide.
   */
  sourceMetadata?: Record<string, unknown>;
  /** Whether this file was automatically processed (vs manual upload) */
  automaticallyProcessed?: boolean;
  /** Metadata for data lake files */
  dataLakeMetadata?: IDataLakeMetadata;

  /** SHA-256 hash of file content for deduplication */
  contentHash?: string;
  /** Batch ID linking this file to a data lake upload batch */
  batchId?: string;
  /** Original relative path from folder upload (preserves directory structure) */
  relativePath?: string;

  sessionId?: string; // For session summaries

  /** Soft-archive marker set when the file's data lake is archived (reversible). */
  archivedAt?: Date;

  /**
   * Non-destructive AI-edit history for binary Office documents (docx/xlsx). Absent for
   * files never AI-edited. Each edit appends an entry and repoints `filePath` at the new
   * version's bytes without deleting the prior key.
   */
  versions?: IFabFileVersion[];

  deletedAt?: Date;
}

export interface IFabFileDocument extends IFabFile, IShareableDocument {}

/**
 * Spread into the `$set` of EVERY update that rewrites a FabFile's bytes in place.
 *
 * A cached `extractedCharCount` describes the previous content, and a stale one makes the pre-send
 * attachment warning silent about a file that no longer fits - the failure that warning exists to
 * prevent. An AI edit growing a 4k file to 44k is the live case: the doc would still say 4,000 and the
 * dry-run would short-circuit to "fits".
 *
 * A shared fragment rather than a literal at each site, because the sites are the problem: the first
 * version of this fix covered only fabFileService/update and missed three live edit routes. A guard
 * test enumerates the rewrite sites and fails if one does not reference this.
 *
 * null, NOT undefined - Mongoose strips undefined from a `$set`, so the undefined form of this leaves
 * the stale number in place and only looks correct.
 */
export const FAB_FILE_CONTENT_REWRITE_PATCH = { extractedCharCount: null } as const;

export interface IFabFileListItem {
  userId: string;
  fileName: string;
  mimeType?: string;
  parentId?: string;
  chunks?: string[];
  chunked?: boolean;
  vectorized?: boolean;
  system?: boolean;
}

export interface IFabFileListItemDocument extends IFabFileListItem, IShareableDocument {}

export interface IFabFileExtended extends IFabFileListItemDocument {
  enabled: boolean;
}

/** Minimal vector-bearing chunk shape returned for semantic search (no full doc hydration). */
export interface FabFileChunkVector {
  id: string;
  fabFileId: string;
  text: string;
  vector: number[];
}

export interface IFabFileChunkRepository extends IBaseRepository<IFabFileChunkDocument> {
  deleteManyByFabFileId(fabFileId: string): Promise<void>;
  /**
   * Every DISTINCT embeddingModel actually used by chunks of the given files - not
   * FabFile.embeddingModel, which is only the file's current/latest model (see
   * IFabFileChunk.embeddingModel: chunks can outlive a re-embed). A retrieval index keyed
   * per-model (e.g. self-host OpenSearch) needs this to know every index a removal must reach.
   */
  distinctEmbeddingModelsByFabFileIds(fabFileIds: string[]): Promise<string[]>;
  bulkInsert(chunks: Omit<IFabFileChunkDocument, 'id'>[]): Promise<IFabFileChunkDocument[]>;
  findByFabFileId(fabFileId: string): Promise<IFabFileChunkDocument[]>;
  /** Count chunks that are terminal (have a vector OR are oversized) - for idempotent vectorizedChunkCount recompute. */
  countTerminalChunks(fabFileId: string, contextWindow: number): Promise<number>;
  /** Bulk-stamp every chunk of a file with the model its vectors were generated under. */
  updateEmbeddingModel(fabFileId: string, embeddingModel: string): Promise<void>;
  /** One page of vector-bearing chunks missing `embeddingModel`, ascending by `_id` - backfill's keyset cursor. */
  findChunksMissingEmbeddingModel(options?: {
    limit?: number;
    afterChunkId?: string;
  }): Promise<Array<{ id: string; fabFileId: string; vectorLength: number }>>;
  /** Atlas `$vectorSearch` over a bounded, already-eligibility-checked file subset for one embedding model. */
  vectorSearch(
    fileIds: string[],
    queryVector: number[],
    model: string,
    options?: { limit?: number }
  ): Promise<Array<{ id: string; fabFileId: string; text: string; score: number }>>;
  /** Whether `model`'s Atlas vector index exists and is queryable (cached; see atlasSearchIndex.ts). */
  getAtlasIndexStatus(model: string): Promise<{ queryable: boolean; status: string } | null>;
  /**
   * One page of vector-bearing chunks (id, fabFileId, text, vector) for the given files,
   * ascending by `_id`. Skips chunks without a vector at the DB layer. Powers semantic search
   * (query embed -> cosine).
   *
   * Contract callers rely on: `_id` is unique, so the ordering is total and `afterChunkId` is
   * an exact cursor - paging a corpus never skips or duplicates a chunk, and the same inputs
   * always yield the same page. An implementation that returns an arbitrary `limit` rows
   * silently changes retrieval results, so ordering is part of the interface, not an optimization.
   */
  findVectorsByFabFileIds(
    fabFileIds: string[],
    options?: { limit?: number; afterChunkId?: string }
  ): Promise<FabFileChunkVector[]>;
  /**
   * One page of chunk TEXT for a single file, ascending by `_id`, same exact-cursor contract as
   * `findVectorsByFabFileIds`. Returns vectorless chunks too - a text consumer that inherited the
   * vector filter would silently drop content.
   */
  findTextsByFabFileId(
    fabFileId: string,
    options?: { limit?: number; afterChunkId?: string }
  ): Promise<{ id: string; text: string }[]>;
  /** Every chunk of a file, vectorless included - lets a paging caller tell a whole file from a slice. */
  countByFabFileId(fabFileId: string): Promise<number>;
}

/**
 * Identifies a data lake for file-membership matching: a file belongs on an exact `datalakeTag`
 * match OR on a `fileTagPrefix` match against a file the lake's CREATOR OWNS. The predicate itself
 * is `buildDataLakeMembershipFilter` in `@bike4mind/database`; this type lives here so
 * `IFabFileRepository` can name it without the packages depending on each other.
 *
 * Always build this from the lake DOCUMENT, never from request input: `creatorUserId` widens what
 * the filter selects, so a caller-supplied scope would reach another user's files - and on the
 * lifecycle paths, destroy them.
 */
export interface DataLakeMembershipScope {
  datalakeTag: string;
  fileTagPrefix?: string | null;
  /** The lake's `createdByUserId` - the identity the prefix arm is anchored to. */
  creatorUserId?: string | null;
}

/**
 * The model interface for the FabFile model.
 *
 * Defines the database methods that are available on the FabFile model.
 */
export interface IFabFileRepository extends IBaseRepository<IFabFileDocument> {
  shareable: IShareableStaticMethods<IFabFileDocument>;
  getAccessibleFiles: (fabFileIds: string[], scope: Record<string, unknown>) => Promise<IFabFileDocument[]>;

  /**
   * Find all files for a user.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to an array of files.
   */
  findByUserId(userId: string): Promise<IFabFileDocument[]>;

  /**
   * Find a file by its ID and the user's ID.
   * @param id - The ID of the file.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to the file.
   */
  findByIdAndUserId(id: string, userId: string): Promise<IFabFileDocument | null>;

  /**
   * Find all files in the given IDs.
   * @param ids - The IDs of the files.
   * @returns A promise that resolves to an array of files.
   */
  findAllInIds(ids: string[]): Promise<IFabFileDocument[]>;

  /**
   * Find files by ID with the heavy and URL-bearing fields projected out, for
   * callers that need to know what a file IS without loading or linking to it.
   * Includes soft-deleted files, so a still-referenced deleted attachment stays
   * visible as such. Capped; `hasMore` reports truncation rather than hiding it.
   * @param ids - The IDs of the files.
   * @param cap - Maximum rows to return.
   */
  findMetadataByIds(ids: string[], cap?: number): Promise<{ data: IFabFileDocument[]; hasMore: boolean }>;

  /**
   * As `findMetadataByIds`, for the files a session currently holds (excludes
   * soft-deleted). Capped; `hasMore` reports truncation rather than hiding it.
   * @param sessionId - The session whose files to list.
   * @param cap - Maximum rows to return.
   */
  findMetadataBySessionId(sessionId: string, cap?: number): Promise<{ data: IFabFileDocument[]; hasMore: boolean }>;

  /**
   * Delete many files in the given IDs.
   * @param ids - The IDs of the files.
   * @returns A promise that resolves to void.
   */
  deleteManyInIds(ids: string[]): Promise<void>;

  /**
   * Find all files in the given IDs.
   * @param ids - The IDs of the files.
   * @returns A promise that resolves to an array of files.
   */
  findAllByIds(ids: string[]): Promise<IFabFileDocument[]>;

  /** Find every non-deleted file belonging to a data-lake ingest batch (source for the post-upload taxonomy analysis job). */
  findByBatchId(batchId: string): Promise<IFabFileDocument[]>;

  /**
   * Search for files.
   * @param userId - The ID of the user.
   * @param search - The search term.
   * @param filters - The filters to apply.
   * @param pagination - The pagination options.
   * @param order - The order to apply.
   * @returns A promise that resolves to an array of files.
   */
  search: (
    userId: string,
    search: string,
    filters: {
      tags?: string[];
      type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code' | 'audio';
      shared?: boolean;
      curated?: boolean;
      fileIds?: string[]; // EXCLUDE these ids ($nin)
      restrictToFileIds?: string[]; // ALLOW-list ($in); present (incl. []) = hard restriction, [] matches nothing
    },
    pagination: { page: number; limit: number },
    order: { by: 'createdAt' | 'fileName' | 'fileSize'; direction: 'asc' | 'desc' },
    options?: {
      textSearch?: boolean;
      includeShared?: boolean;
      userGroups?: string[]; // Required when includeShared is true - user's group IDs for org-level sharing
      dataLakeTags?: string[]; // Include files tagged with these datalake: meta-tags
      dataLakeTagPrefixes?: string[]; // OPEN static-registry prefixes (e.g. 'opti:') — ownership-bypass by design
      scopedTagPrefixes?: string[]; // SCOPED dynamic-lake prefixes — matched ONLY within owner/org/shared access
      restrictToDataLake?: boolean; // Single-lake view: return ONLY this lake's files, not all owned files
      /**
       * One lake's membership scope, matching the whole-lake writes exactly. Server-supplied
       * only: it names the creator whose OWNED files the prefix arm matches, so it must never be
       * read from request input.
       */
      lakeMembership?: DataLakeMembershipScope;
      skipOwnership?: boolean; // Allow-list-as-authority: skip the ownership predicate; ignored unless restrictToFileIds is present
      excludeContent?: boolean; // Exclude heavy fields (content, chunks, vector) for list queries
      excludeFilenameMarkers?: string[]; // Generic retrieval exclusion: leading word-boundary marker match (see @bike4mind/utils/retrievalExclusion)
      vectorizedOnly?: boolean; // Restrict to vectorized files only (excludes unvectorized)
      stableSort?: boolean; // Add an `_id` tiebreaker so a multi-page walk can't drop/repeat a file (fileName sorts only)
    }
  ) => Promise<{ data: IFabFileDocument[]; hasMore: boolean; total: number }>;

  /**
   * Execute a pre-built search query (thin executor - no business logic).
   * @param query - Pre-built MongoDB query from buildFabFileSearchQuery().
   *                The builder inflates query.limit by +1 over the page size to
   *                detect hasMore; executeSearch trims the result back to pageSize.
   * @param pageSize - The caller's requested page size (number of items returned to user).
   */
  executeSearch: (
    query: {
      filter: Record<string, unknown>;
      sort: Record<string, 1 | -1>;
      collation: { locale: string } | null;
      skip: number;
      limit: number;
      excludeContent?: boolean;
    },
    pageSize: number
  ) => Promise<{ data: IFabFileDocument[]; hasMore: boolean; total: number }>;

  /**
   * Count a user's live files carrying one tag. Matches the WHOLE name, case-insensitively - a
   * `test` tag does not count files tagged `testing`. Excludes soft-deleted files, unlike the
   * write paths that keep tag names in step.
   */
  countByUserIdAndTag(userId: string, tag: string): Promise<number>;

  /**
   * Count the number of files by tag for a user.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to the number of files.
   */
  countFilesByTagForUser(
    userId: string,
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
    }
  ): Promise<{ tag: string; count: number }[]>;

  /**
   * Count tags matching specific prefixes across data-lake-accessible files.
   * Used by the Data Lake Explorer to build the tag tree without fetching all articles.
   */
  countDataLakeTagsByPrefix(
    userId: string,
    tagPrefixes: string[],
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
    }
  ): Promise<{ tag: string; count: number }[]>;

  /**
   * Count unique data-lake FILES (not tag occurrences) under the same scoping as
   * countDataLakeTagsByPrefix. Returns the combined unique total plus a per-prefix
   * breakdown. Used to render truthful KB-article counts on the OptiHashi surfaces.
   */
  countDataLakeUniqueFilesByPrefix(
    userId: string,
    tagPrefixes: string[],
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
    }
  ): Promise<{ total: number; byPrefix: Record<string, number> }>;

  /**
   * Count unique files per root tag namespace for a user. Takes the same optional scope as
   * countFilesByTagForUser, which it is served beside; omitting it counts owned files only.
   */
  countUniqueFilesByNamespaceForUser(
    userId: string,
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
    }
  ): Promise<{ namespace: string; fileCount: number }[]>;

  /**
   * Strip one tag name off every file a user owns, so deleting a tag document cannot leave the
   * name orphaned on the files that carried it. Matches the WHOLE name, case-insensitively, and
   * removes every occurrence - including a name a file carries twice.
   *
   * Includes SOFT-DELETED files, unlike most reads here: a soft-deleted file that kept the name
   * would resurrect a tag that no longer exists the moment it is undeleted. Also clears
   * `primaryTag` where it named the removed tag.
   *
   * Scoped to files the user OWNS. A file shared to them but owned by someone else keeps the
   * name, which is correct - one user's tag edit must not rewrite another user's file.
   *
   * @returns files modified by the tag removal (not tags removed, and not counting the
   * `primaryTag` sweep).
   */
  removeTagByUserId(userId: string, tag: string): Promise<number>;

  /**
   * Rename one tag on every file a user owns, so renaming a tag document cannot leave the old name
   * orphaned on the files that carried it. Matches the WHOLE name, case-insensitively, and renames
   * EVERY occurrence in a file's tags array rather than only the first. Includes soft-deleted files
   * and carries `primaryTag` across, for the same reasons as `removeTagByUserId`.
   *
   * May leave a file carrying `newTag` twice - once from the rename and once because it already
   * had that tag. The caller resolves it with `dedupeTagByUserId`; doing both in one write would
   * mean rewriting the whole array and losing the element-level concurrency this buys.
   *
   * @returns files modified by the rename (not the `primaryTag` sweep).
   */
  updateTagsByUserId(userId: string, tag: string, newTag: string): Promise<number>;

  /**
   * Collapse a repeated tag name to a single entry on every file of a user's that carries it more
   * than once, normalizing the survivor to `name`'s casing. Keeps the FIRST occurrence and its
   * other fields (`strength`, and anything this schemaless array happens to hold).
   *
   * The companion to `updateTagsByUserId`: renaming in place is what creates the duplicate, when a
   * file already carried the target name.
   *
   * @returns the number of files that actually had a duplicate to collapse.
   */
  dedupeTagByUserId(userId: string, name: string): Promise<number>;

  /**
   * Atomically remove every tag matching one of `tagNames` (exact names) from one file's
   * tags array, and clear `primaryTag` if it named one of them. Uses `$pull`, so concurrent
   * removals of DIFFERENT tags on the same file don't clobber each other the way a
   * read-filter-write `$set: { tags }` would. Absent names are a no-op (idempotent).
   *
   * Matching is case-SENSITIVE, unlike its `pushTagsByFabFileId` counterpart: names must be
   * given exactly as stored, resolved from the loaded document rather than from user input.
   * Passing a user's `foo` against a stored `Foo` removes nothing and reports no error.
   * @param fabFileId - The ID of the file.
   * @param tagNames - The exact tag names to remove. Empty is a no-op.
   * @returns Documents modified by the pull. The schema has timestamps, so this can be 1
   * even when no tag matched - do not read it as "a tag was removed".
   */
  pullTagsByFabFileId(fabFileId: string, tagNames: string[]): Promise<number>;

  /**
   * Atomically add each of `tagNames` to one file's tags array, skipping any already present.
   * The add counterpart to `pullTagsByFabFileId`: one filtered `$push` per name, so concurrent
   * adds of DIFFERENT tags on the same file don't clobber each other and a re-add is a no-op
   * rather than a duplicate.
   *
   * Presence is compared by EXACT name, matching the pull half and the read path (which admits
   * a tag by exact `$in`), and a new name is stored with the caller's casing, never lowercased.
   * Case-insensitive matching here would be wrong, not merely stricter: a file carrying some
   * other casing of a lake's meta-tag is not a member of that lake, so the canonical tag has to
   * be insertable alongside it. Callers that want case-insensitive semantics resolve the stored
   * spelling from the document first, as the tag-toggle path does. A filter is not a unique
   * index, so two SIMULTANEOUS adds of one name can both pass; `pullTagsByFabFileId` removes both.
   * @param fabFileId - The ID of the file.
   * @param tagNames - Tag names to add, deduplicated. Empty is a no-op.
   * @param strength - Relevance weight stored on each new tag. Defaults to 0; the data-lake
   * membership meta-tag is written at 1.
   * @returns The number of tags actually inserted. Unlike the pull half this IS meaningful: a
   * name already present fails its filter, so it neither counts nor bumps updatedAt.
   */
  pushTagsByFabFileId(fabFileId: string, tagNames: string[], strength?: number): Promise<number>;

  /**
   * Bulk-writes each file's full tags array in a single round trip via bulkWrite, instead of
   * one findOneAndUpdate per file. Used by applyTaxonomySuggestions, where a batch can hold
   * thousands of files and one write per file risks exceeding the caller's request timeout.
   *
   * Optimistic concurrency: each op is additionally filtered on `expectedTags`, the exact
   * array the caller read before computing `tags`. If another writer (a direct tag edit, a
   * lake-membership tag pull, a concurrent apply) changed the file's tags since that read, the
   * filter no longer matches and this op is a silent no-op instead of clobbering the
   * concurrent change - the caller's merge logic ran against stale data, so writing it would
   * be wrong regardless of what it computed.
   * @param updates - Each file's id, its complete resolved tags array, and the tags snapshot
   * the resolution was computed from.
   * @returns Number of documents modified (may be less than `updates.length` - see above).
   */
  bulkUpdateTags(
    updates: {
      id: string;
      tags: { name: string; strength: number }[];
      expectedTags: { name: string; strength: number }[];
    }[]
  ): Promise<number>;

  /**
   * Find files by content hashes for a given user (deduplication).
   * @param userId - The ID of the user.
   * @param hashes - Array of SHA-256 content hashes to look up.
   * @returns Files matching any of the provided hashes.
   */
  findByContentHashes(userId: string, hashes: string[]): Promise<IFabFileDocument[]>;
  /**
   * Files in a lake matching any hash, by META-TAG ONLY - deliberately narrower than the
   * `DataLakeMembershipScope` the rest of the lifecycle family takes. Its callers act on the
   * answer destructively (the unarchive dedup hard-deletes the losing copy) or by skipping a
   * caller's upload, and every re-upload path that matters writes the meta-tag, so admitting a
   * prefix match here would risk the wrong file for no gain.
   */
  findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  markFailedIfNotAlready(fabFileId: string, errorMessage: string): Promise<boolean>;

  // ── Data lake lifecycle. Scoped by DataLakeMembershipScope - the lake's meta-tag OR a
  // fileTagPrefix match on a file the lake's creator OWNS. See buildDataLakeMembershipFilter
  // in @bike4mind/database for the rule and why the prefix arm needs the ownership conjunct. ──

  /**
   * Authoritative lake stats recomputed from source records via an aggregate (NOT
   * find().length). Counts only live files (not archived, not deleted).
   */
  computeDataLakeStats(scope: DataLakeMembershipScope): Promise<{ fileCount: number; totalSizeBytes: number }>;
  /**
   * Distinct live file count per lake, keyed by `datalakeTag`. Same predicate as
   * computeDataLakeStats, so what a browse surface displays cannot disagree with a lake's
   * stored stats. Prefer this over counting `<prefix>:` tag matches, which misses files that
   * carry only the membership tag and over-counts multi-tagged ones.
   */
  countDataLakeFilesByMembership(scopes: DataLakeMembershipScope[]): Promise<Record<string, number>>;
  // The delete/restore pair is STAMP-KEYED. Phase-1 delete takes `at` and writes that one value
  // to every row it flips; it records the stamp on the lake and restore passes it back as
  // `stampedAt` to reverse exactly that batch. `stampedAt` matches by EQUALITY - deliberately not a
  // lower bound, which would also match a file the creator deleted during the deleted window (the
  // per-file delete routes stamp `deletedAt` too) and revive it on restore. Omitting `stampedAt`
  // matches every stamped row: the pre-mark behavior, and the fallback for a lake torn down before
  // the mark existed. The archive axis is stamped the same way (`at`, `filesArchivedAt`) so restore
  // can also clear `archivedAt` for exactly the batch this lake's own archive wrote, without
  // freeing a prefix-sharing sibling's independently-archived files.

  /**
   * Soft-archive (reversible) all live member files, stamped `at`. Returns affected count.
   * Omitting `at` still writes a real per-row timestamp - it is orphaned (no lake names it), not
   * absent. See archiveDataLake's `hasUnstampedArchive` guard for when that's intentional.
   */
  archiveByDataLakeTag(scope: DataLakeMembershipScope, at?: Date): Promise<number>;
  /** Reverse archive for all archived member files. Unbounded - matches on archivedAt alone. */
  unarchiveByDataLakeTag(scope: DataLakeMembershipScope): Promise<number>;
  /** Archived member files - used by the unarchive dedup pass. */
  findArchivedByDataLakeTag(scope: DataLakeMembershipScope): Promise<IFabFileDocument[]>;
  /** Existence-only form of findArchivedByDataLakeTag, for a caller that just needs "any?". */
  hasArchivedByDataLakeTag(scope: DataLakeMembershipScope): Promise<boolean>;
  /** Soft-deleted member files stamped `stampedAt` - used by the deleted->active restore dedup pass. */
  findDeletedByDataLakeTag(scope: DataLakeMembershipScope, stampedAt?: Date): Promise<IFabFileDocument[]>;
  /**
   * Reverse soft-delete for member files stamped `stampedAt`, minus `excludeIds` (discarded
   * duplicates). When `archiveStampToClear` is given, also clears `archivedAt` on the subset of
   * the restored batch whose archivedAt equals it (the batch this lake's own archive wrote) -
   * everything else keeps its archive marker untouched. Returns count restored.
   */
  undeleteByDataLakeTag(
    scope: DataLakeMembershipScope,
    excludeIds?: string[],
    stampedAt?: Date,
    archiveStampToClear?: Date
  ): Promise<number>;
  /** Soft-delete (phase 1) all member files, stamped `at`. Returns affected file ids. */
  softDeleteByDataLakeTag(scope: DataLakeMembershipScope, at?: Date): Promise<string[]>;
  /**
   * Hard-delete (phase 2) all member files, including soft-deleted. Returns purged ids. Idempotent.
   *
   * Resolves membership at call time, so it can destroy a file that became a member after the
   * caller last looked. A caller that has already acted on a resolved id set - deleted its chunks,
   * told a retrieval index - must purge that same set via `hardDeleteByIds` instead, or it
   * destroys rows it never accounted for.
   */
  hardDeleteByDataLakeTag(scope: DataLakeMembershipScope): Promise<string[]>;
  /**
   * Hard-delete exactly these files, including soft-deleted ones. Idempotent.
   *
   * Echoes back the ids it was GIVEN, not the rows it actually removed - a second call with the
   * same ids returns them again. Do not read the result as "what this call deleted"; if you need
   * that, count before and after.
   *
   * Ids must come from a prior repository read. They go straight into an `_id` query, so a
   * malformed one throws a CastError partway through the delete.
   */
  hardDeleteByIds(fabFileIds: string[]): Promise<string[]>;
  /** All member file ids (including soft-deleted), for chunk/index cleanup. */
  findIdsByDataLakeTag(scope: DataLakeMembershipScope): Promise<string[]>;
}
