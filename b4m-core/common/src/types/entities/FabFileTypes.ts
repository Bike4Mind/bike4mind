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
  bulkInsert(chunks: Omit<IFabFileChunkDocument, 'id'>[]): Promise<IFabFileChunkDocument[]>;
  findByFabFileId(fabFileId: string): Promise<IFabFileChunkDocument[]>;
  /** Count chunks that are terminal (have a vector OR are oversized) - for idempotent vectorizedChunkCount recompute. */
  countTerminalChunks(fabFileId: string, contextWindow: number): Promise<number>;
  /**
   * Bulk-fetch vector-bearing chunks (id, fabFileId, text, vector) for many files in ONE
   * indexed query, capped for memory safety. Powers semantic search (query embed -> cosine).
   * Skips chunks without a vector at the DB layer.
   */
  findVectorsByFabFileIds(fabFileIds: string[], cap?: number): Promise<FabFileChunkVector[]>;
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
      type?: 'text' | 'pdf' | 'url' | 'image' | 'excel' | 'word' | 'json' | 'csv' | 'markdown' | 'code';
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
      skipOwnership?: boolean; // Allow-list-as-authority: skip the ownership predicate; ignored unless restrictToFileIds is present
      excludeContent?: boolean; // Exclude heavy fields (content, chunks, vector) for list queries
      excludeFilenameMarkers?: string[]; // Generic retrieval exclusion: leading word-boundary marker match (see @bike4mind/utils/retrievalExclusion)
      vectorizedOnly?: boolean; // Restrict to vectorized files only (excludes unvectorized)
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
   * Count the number of files by user id and tag.
   * @param userId - The ID of the user.
   * @param tag - The tag to count.
   * @returns A promise that resolves to the number of files.
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
   * Count unique files per root tag namespace for a user.
   */
  countUniqueFilesByNamespaceForUser(userId: string): Promise<{ namespace: string; fileCount: number }[]>;

  /**
   * Remove a tag from a user's files.
   * @param userId - The ID of the user.
   * @param tag - The tag to remove.
   * @returns A promise that resolves to the number of files.
   */
  removeTagByUserId(userId: string, tag: string): Promise<number>;

  /**
   * Update the tags for a user's files.
   * @param userId - The ID of the user.
   * @param tag - The tag to update.
   * @returns A promise that resolves to the number of files.
   */
  updateTagsByUserId(userId: string, tag: string, newTag: string): Promise<number>;

  /**
   * Atomically remove a single tag (matched by exact name) from one file's tags array.
   * Uses `$pull`, so concurrent removals of DIFFERENT tags on the same file don't clobber
   * each other the way a read-filter-write `$set: { tags }` would. No-op if the tag is
   * absent (idempotent).
   * @param fabFileId - The ID of the file.
   * @param tagName - The exact tag name to remove.
   * @returns The number of files modified (0 if the tag was not present).
   */
  pullTagByFabFileId(fabFileId: string, tagName: string): Promise<number>;

  /**
   * Find files by content hashes for a given user (deduplication).
   * @param userId - The ID of the user.
   * @param hashes - Array of SHA-256 content hashes to look up.
   * @returns Files matching any of the provided hashes.
   */
  findByContentHashes(userId: string, hashes: string[]): Promise<IFabFileDocument[]>;
  findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  markFailedIfNotAlready(fabFileId: string, errorMessage: string): Promise<boolean>;

  // ── Data lake lifecycle (scoped by the lake's datalake: meta-tag) ──────────

  /**
   * Authoritative lake stats recomputed from source records (indexed aggregate,
   * NOT find().length). Counts only live files (not archived, not deleted).
   */
  computeDataLakeStats(datalakeTag: string): Promise<{ fileCount: number; totalSizeBytes: number }>;
  /** Soft-archive (reversible) all live files in a lake. Returns affected count. */
  archiveByDataLakeTag(datalakeTag: string): Promise<number>;
  /** Reverse archive for all archived files in a lake. */
  unarchiveByDataLakeTag(datalakeTag: string): Promise<number>;
  /** Archived files in a lake - used by the unarchive dedup pass. */
  findArchivedByDataLakeTag(datalakeTag: string): Promise<IFabFileDocument[]>;
  /** Soft-deleted files in a lake - used by the deleted->active restore dedup pass. */
  findDeletedByDataLakeTag(datalakeTag: string): Promise<IFabFileDocument[]>;
  /** Reverse soft-delete for a lake's files, optionally excluding ids (discarded duplicates). Returns count. */
  undeleteByDataLakeTag(datalakeTag: string, excludeIds?: string[]): Promise<number>;
  /** Soft-delete (phase 1) all files in a lake. Returns affected file ids. */
  softDeleteByDataLakeTag(datalakeTag: string): Promise<string[]>;
  /** Hard-delete (phase 2) all files in a lake, including soft-deleted. Returns purged ids. Idempotent. */
  hardDeleteByDataLakeTag(datalakeTag: string): Promise<string[]>;
  /** All file ids carrying the lake meta-tag (including soft-deleted), for chunk/index cleanup. */
  findIdsByDataLakeTag(datalakeTag: string): Promise<string[]>;
}
