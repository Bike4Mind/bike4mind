import { type ChunkStallReason } from '../../constants/chunking';
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
  /** Admitted by a human approving an acquisition proposal (#1671), never by the producer itself. */
  PROPOSAL_APPROVAL = 'proposal_approval',
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
  /**
   * Length of `text` in Unicode CODE POINTS (countCodePoints on the write path, $strLenCP in the
   * backfill - the two must agree, which is why this is NOT UTF-16 `text.length`). Written at
   * chunk time; absent on chunks that predate the field until
   * packages/scripts/datalake/backfill-chunk-char-length.ts runs. Unit basis for the lake
   * health predicates (#1666), which are stated in characters because the serve cap is.
   */
  charLength?: number;
  vector?: number[];
  /**
   * Embedding model this chunk's vector was generated with. Chunks can outlive their file's
   * current `embeddingModel` (re-embedding, backfill), so this is the per-chunk source of truth
   * an Atlas `$vectorSearch` index lookup keys on - not FabFile.embeddingModel.
   */
  embeddingModel?: string;
  /**
   * Which per-model retrieval index this chunk's document was written to, for a retrieval store
   * that lives OUTSIDE Mongo (self-host OpenSearch; undefined on Atlas, whose vector index is on
   * this collection itself and so is removed with the row).
   *
   * Deliberately NOT `embeddingModel`. That field is a READINESS stamp: fabFileVectorize writes it
   * only once the whole file finishes, so the Atlas cutover read path can never treat a
   * still-vectorizing file as ready. But OpenSearch documents are written per vectorize MESSAGE,
   * long before that - so a file whose vectorize never finishes (spend-gate denial, exhausted SQS
   * retries, a purge landing mid-flight) has live documents and no stamp, and every removal path
   * resolves its index from the stamp. Recording index residency separately is what lets a removal
   * find those documents.
   *
   * Written just BEFORE the OpenSearch write, not after: the write is fail-open, and a removal for
   * an index that holds nothing is a harmless no-op, whereas a missed one orphans documents.
   */
  retrievalIndexModel?: string;
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

/** One member lake whose required chunk policy a file's current chunks do not satisfy (#1662). */
export interface FabFileChunkPolicyConflictLake {
  /** DB lake id when known; absent for a static-registry lake (which carries no requirement). */
  lakeId?: string;
  /** The lake's meta-tag ("datalake:<slug>"), always present for attribution. */
  datalakeTag: string;
  name: string;
  /** The raw target the lake requires (operator-set), for display. */
  requiredTarget: number;
  /** That required target after the model-window clamp - what the conflict is actually decided on. */
  effectiveRequiredTarget: number;
}

/**
 * Records that a file belongs to one or more data lakes whose REQUIRED chunk policy its current
 * chunks do not satisfy (#1662). Chunk policy is resolved at file-OWNER altitude; a lake is a
 * CONSTRAINT, not an override, so a mismatch is reported here (and logged/pushed) rather than
 * silently re-chunking - which would rewrite chunks for non-members and oscillate for a file tagged
 * into two lakes whose requirements disagree.
 */
export interface FabFileChunkPolicyConflict {
  /** The file's effective chunk target (TOKENS, post model-window clamp) its chunks were built with. */
  effectiveTarget: number;
  /** The embedding model both effective targets were computed against. */
  embeddingModel: string;
  /** Member lakes whose required policy this file's chunks do not satisfy. */
  lakes: FabFileChunkPolicyConflictLake[];
  detectedAt: Date;
}

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

  /**
   * The OWNER's own note on the file, and nothing else. No pipeline path writes or clears it (#2016):
   * the chunk/vector stall markers that used to share this string live in `chunkStallReason` and
   * `noExtractableTextAt`, because every writer of a single prose field clobbers the others - a
   * "Rebuild passages" wave silently deleted whatever the owner had typed.
   */
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
  /**
   * Sum of this file's chunks' `charLength` (Unicode code points), stamped by chunkFabfile in
   * the same update as `chunkCount`. The chunk-derived counterpart of `extractedCharCount`,
   * which a DIFFERENT extractor writes lazily on the composer dry-run path - the two
   * legitimately drift and must not be conflated. Nullable for the same reason as
   * extractedCharCount: a content rewrite nulls it via FAB_FILE_CONTENT_REWRITE_PATCH (Mongoose
   * strips undefined from $set) and the re-chunk that follows re-stamps it.
   */
  chunkedCharCount?: number | null;
  /**
   * Largest single chunk's `charLength` (Unicode code points), stamped by chunkFabfile beside
   * `chunkedCharCount`. Feeds lake-health predicate P1 (#1666: no chunk exceeds the policy size)
   * as a per-file rollup, so health never rescans the chunk collection - the read that #1665
   * measured as ruinous on a connector-fed lake. `null`/absent = UNMEASURED (predates the field or
   * a content rewrite cleared it), distinct from `0`; nulled with `chunkedCharCount` on rewrite.
   */
  maxChunkCharLength?: number | null;
  /**
   * Count of this file's chunk rows that carry a VECTOR, recomputed from source at vectorize
   * completion. Feeds lake-health predicate P3 (#1666: vector-bearing rows >= chunkCount).
   * Deliberately NOT `vectorizedChunkCount`, which counts a chunk terminal if it has a vector OR is
   * too large to embed - so an un-embeddable oversized chunk reads as "done" there and would hide
   * exactly the gap P3 exists to catch. Measurable from vector presence alone (no char data), so P3
   * grades before the char-length backfill runs. Absent = not yet computed (distinct from `0`).
   */
  embeddedChunkCount?: number | null;
  /**
   * Sum of `charLength` over this file's VECTOR-bearing chunks, recomputed at vectorize completion.
   * The reachable-content numerator for lake health (#1666): a chunk's characters count toward what
   * can reach the model only if the chunk is retrievable (has a vector). Nullable/absent =
   * unmeasured; nulled with `chunkedCharCount` on a content rewrite.
   */
  embeddedCharCount?: number | null;

  /** Whether this FabFile is currently being chunked. */
  isChunking?: boolean;
  /** When `isChunking` was last set true - the rescue sweep uses this to reclaim a claim stranded
   *  by a hard worker crash that never cleared it (see buildFabFileChunkScanFilter). */
  chunkClaimedAt?: Date | null;
  /** Written by confirmChunkClaim on every matched call - purely so that write is never a
   *  byte-for-byte no-op MongoDB could elide. Not read anywhere; see confirmChunkClaim's doc. */
  chunkClaimConfirmedAt?: Date | null;
  /** Whether this FabFile has been chunked */
  chunked?: boolean;
  /**
   * The effective chunk passage target (TOKENS, post model-window clamp) this file's CURRENT chunks
   * were produced with (#1662). Recorded by the chunk handler so a later lake-membership change can
   * check a lake's required policy against the file WITHOUT re-chunking. Absent on files chunked
   * before this landed.
   */
  chunkedPassageTokenTarget?: number;
  /**
   * When a passage REBUILD was requested for this file, stamped by `resetChunkStateByIds` in the
   * same write that clears the chunk rollups (#1939). `null`/absent means no rebuild is outstanding.
   *
   * The reset and the queue send are two operations, so without this the gap between them carries no
   * marker at all: `chunkCount: 0`, `error: null` and no stall reason is the shape of an image or a
   * still-uploading row, and the file drops out of health, convergence and the retrieval withhold at
   * once. Cleared by `commitFabFileChunks` when the rebuild lands, and UPGRADED to
   * `chunkStallReason: 'rechunkPaused'` by the chunk handler when the kill switch halts it instead -
   * see `isChunkRebuildPending` for why a pending rebuild must not simply pre-write that marker.
   *
   * `null` rather than undefined for the same reason as `extractedCharCount`: the repository's `$set`
   * strips undefined, which would leave a stale stamp in place.
   */
  chunkRebuildRequestedAt?: Date | null;

  /**
   * Why this file's chunk/vector pipeline is STALLED, or `null`/absent when it is not (#2016). Both
   * arms of the convergence kill switch stamp it; `commitFabFileChunks` clears it when the repair
   * lands. See `ChunkStallReason` for the values, `isChunkStalled` for the predicate every reader
   * uses, and `CHUNK_STALL_NOTICES` for the owner-facing prose.
   *
   * `null` rather than undefined for the same reason as `chunkRebuildRequestedAt`: the repository's
   * `$set` strips undefined, which would leave a stale marker in place.
   */
  chunkStallReason?: ChunkStallReason | null;

  /**
   * When chunking last produced ZERO chunks for this file (#2016) - usually a failed or partial
   * extraction (image-only, a parser-unfriendly .docx), occasionally a genuinely empty document.
   * `null`/absent means text was extracted.
   *
   * TERMINAL for the chunk rescue sweep (`buildFabFileChunkScanFilter`), which is why it is a stored
   * fact rather than a re-derivation: re-enqueueing such a file would fail identically every cycle.
   * `resetChunkStateByIds` clears it, so the explicit reprocess path is the way back in.
   */
  noExtractableTextAt?: Date | null;

  /**
   * Set when this file belongs to data lakes whose required chunk policy its current chunks do not
   * satisfy (#1662); `null`/absent means no conflict. A report, not a failure: the file stays
   * chunked at its owner-altitude policy. Cleared when a re-chunk or membership change resolves it.
   */
  chunkPolicyConflict?: FabFileChunkPolicyConflict | null;

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

  /**
   * SHA-256 (hex) over the file's normalized server-extracted text, computed at chunk time by the
   * admission contract (`computeServerTextHash`). Hashed over the CANONICAL EXTRACTED TEXT, not the
   * chunk output, so it is stable across chunk-policy/embedding-model changes - the trustworthy dedup
   * input for #1671, distinct from `contentHash` (client-side raw BYTES, unverified, absent on
   * connector files). Tri-state: absent = never chunked (treat as UNKNOWN, never "no text"); null =
   * chunked with no extractable text; hex = fingerprint. Nulled by FAB_FILE_CONTENT_REWRITE_PATCH on
   * a byte rewrite and by the chunk pass on a text-less re-chunk, so it never outlives its text.
   */
  serverTextHash?: string | null;

  /** Batch ID linking this file to a data lake upload batch */
  batchId?: string;
  /** Original relative path from folder upload (preserves directory structure) */
  relativePath?: string;

  // Google Drive ingest provenance (#1589). Populated when sourceType === GOOGLE_DRIVE.
  /** Drive file id this FabFile was ingested from - the stable dedup key within a lake. */
  driveFileId?: string;
  /** Drive modifiedTime captured at ingest, for change detection on re-sync. */
  driveModifiedTime?: Date;
  /** Drive md5Checksum captured at ingest (native binaries only), for change detection. */
  driveMd5Checksum?: string;
  /** The data lake this file was ingested into (provenance). */
  sourceLakeId?: string;
  /** The OrgGoogleDriveConnection that ingested this file (provenance). */
  driveConnectionId?: string;

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
 *
 * Also clears the chunk-derived rollups (`chunkedCharCount`, `maxChunkCharLength`, `embeddedChunkCount`,
 * `embeddedCharCount`) and `serverTextHash`, the admission contract's fingerprint of the extracted text
 * (#1679): each is derived from the file's content, so a byte rewrite invalidates them, and the
 * re-chunk / re-vectorize that follows re-stamps them. Leaving the rollups would grade lake health
 * (#1666) against the PREVIOUS content's chunks - reporting a reachability the current bytes do not
 * have; leaving the hash would let a stale fingerprint claim text the file no longer holds.
 */
export const FAB_FILE_CONTENT_REWRITE_PATCH = {
  extractedCharCount: null,
  chunkedCharCount: null,
  maxChunkCharLength: null,
  embeddedChunkCount: null,
  embeddedCharCount: null,
  serverTextHash: null,
  // Content-derived like the rest: the stamp asserts "no text in this file" about bytes the rewrite
  // replaced. Leaving it would keep the rescue sweep's terminal guard closed against the new content.
  noExtractableTextAt: null,
} as const;

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
   * Every DISTINCT per-model retrieval index the given files' chunks can have documents in - the
   * union of `IFabFileChunk.retrievalIndexModel` (index residency, recorded per vectorize message)
   * and `IFabFileChunk.embeddingModel` (the file-complete readiness stamp). Both are needed:
   * residency alone misses chunks indexed before that field existed, and the stamp alone misses
   * every file whose vectorize never finished. Neither is FabFile.embeddingModel, which is only the
   * file's current/latest model and misses an index left by an earlier embed.
   */
  distinctRetrievalIndexModelsByFabFileIds(fabFileIds: string[]): Promise<string[]>;
  /**
   * The same fact as above, but resolved PER FILE: `{ [fabFileId]: models }`, omitting any file with
   * no model-bearing chunks. A per-model retrieval index needs the pairing, not the union - pairing
   * every file with every model seen across the batch issues one request per (file, model) cell, so
   * a two-model lake doubles its removal traffic and most of it matches nothing.
   */
  retrievalIndexModelsByFabFileIds(fabFileIds: string[]): Promise<Record<string, string[]>>;
  bulkInsert(chunks: Omit<IFabFileChunkDocument, 'id'>[]): Promise<IFabFileChunkDocument[]>;
  findByFabFileId(fabFileId: string): Promise<IFabFileChunkDocument[]>;
  /**
   * The file's vectorize rollup in ONE pass over its chunks (the `vector` fetch is unavoidable and
   * must not be paid twice per batch):
   *  - `terminalChunkCount`: chunks that have a vector OR are oversized past the context window
   *    (permanently unembeddable) - i.e. `vectorizedChunkCount`, recomputed from source (not `+=`) so
   *    an SQS redelivery of a partial-batch vectorize message is idempotent.
   *  - `embeddedChunkCount`/`embeddedCharCount`: only chunks that TRULY carry a vector (lake-health
   *    P3, #1666), because P3 asks whether content is FINDABLE; an oversized-unembeddable chunk counts
   *    toward terminal but not here. `embeddedCharCount` reflects only chunks whose `charLength` is present.
   */
  computeChunkVectorRollup(
    fabFileId: string,
    contextWindow: number
  ): Promise<{ terminalChunkCount: number; embeddedChunkCount: number; embeddedCharCount: number }>;
  /**
   * All four lake-health (#1666) file rollups in one pass over a file's chunks - the metadata
   * backfill's per-file input. `chunkedCharCount`/`maxChunkCharLength` cover all chunks;
   * `embeddedChunkCount`/`embeddedCharCount` cover only vector-bearing ones.
   */
  computeFileChunkRollups(fabFileId: string): Promise<{
    chunkedCharCount: number;
    maxChunkCharLength: number;
    embeddedChunkCount: number;
    embeddedCharCount: number;
  }>;
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
  /** One page of chunk ids still missing `charLength`, ascending by `_id` - backfill's keyset cursor. */
  findChunkIdsMissingCharLength(options?: { limit?: number; afterChunkId?: string }): Promise<string[]>;
  /** Server-side $strLenCP stamp of `charLength` on the given chunks; chunk text never leaves the DB. */
  backfillCharLengthByIds(chunkIds: string[]): Promise<number>;
  /** Sum of a file's chunks' charLength, unstamped chunks counted as 0. */
  sumChunkCharLengthByFabFileId(fabFileId: string): Promise<number>;
  /**
   * Of the given files, those with at least one chunk larger than `tokenThreshold` - i.e. files
   * whose passages predate the passage-target fix (a whole-document blob, not a ~512-token
   * passage). Returned worst-first (largest oversized chunk first) so a bounded rebuild wave
   * repairs the least-retrievable files first. Powers the lake "Rebuild passages" detection.
   */
  findUnderChunkedFabFileIds(fabFileIds: string[], tokenThreshold: number): Promise<string[]>;
}

/**
 * Identifies a data lake for file-membership matching. The predicate itself is
 * `buildDataLakeMembershipFilter` in `@bike4mind/database`; this type lives here so
 * `IFabFileRepository` can name it without the packages depending on each other.
 *
 * TWO membership models, both legitimate, discriminated so a consumer cannot silently get the
 * wrong one:
 *
 * - `owned` (DB lake): meta-tag OR (`fileTagPrefix` match AND the file is owned by the lake's
 *   CREATOR). The prefix is user-chosen and unique only per creator, so the ownership conjunct is
 *   what stops one lake's prefix from reaching another tenant's files.
 * - `registry` (hardcoded DATA_LAKES lake): meta-tag OR `fileTagPrefix`, with NO ownership arm.
 *   Such a lake is a shared knowledge base with many contributors and no creator to anchor to.
 *   Safe ONLY because the prefix is compile-time config - see the ownership-bypass note on
 *   `dataLakeTagPrefixes` in fabFileSearchQuery, which this replaces FOR PER-LAKE MEMBERSHIP only.
 *   That mechanism is still live and must not be removed: the multi-lake retrieval surfaces
 *   (semantic-search, the knowledge-base tools, ChatCompletionFeatures, and the tag-count prefix
 *   arms) pass it for a whole SET of lakes at once, which a single-lake scope cannot express.
 *
 * A discriminated union rather than an optional `creatorUserId` because the previous shape could
 * not express the registry model at all: the filter DEGRADED a creator-less scope to meta-tag-only,
 * which under-counted registry lakes and forced the browse path to hand-roll the correct predicate
 * at its own call site. The two then disagreed, violating the invariant stated on
 * `countDataLakeFilesByMembership` below.
 *
 * Always build these from the lake DOCUMENT (`owned`) or the hardcoded registry entry
 * (`registry`), never from request input: the prefix arm widens what the filter selects, and on
 * the lifecycle paths that means destroying files.
 */
export type DataLakeMembershipScope =
  | {
      kind: 'owned';
      datalakeTag: string;
      fileTagPrefix?: string | null;
      /** The lake's `createdByUserId` - the identity the prefix arm is anchored to. */
      creatorUserId?: string | null;
    }
  | {
      kind: 'registry';
      datalakeTag: string;
      /** From the hardcoded DATA_LAKES registry ONLY - never a user-supplied prefix. */
      fileTagPrefix?: string | null;
    };

/**
 * The model interface for the FabFile model.
 *
 * Defines the database methods that are available on the FabFile model.
 */
export interface IFabFileRepository extends IBaseRepository<IFabFileDocument> {
  shareable: IShareableStaticMethods<IFabFileDocument>;
  getAccessibleFiles: (fabFileIds: string[], scope: Record<string, unknown>) => Promise<IFabFileDocument[]>;

  /**
   * Persist the chunk-policy outcome for a file (#1662): the effective target its current chunks
   * were built with, plus the cross-lake conflict report (`null` clears a now-resolved conflict).
   * One atomic $set so the recorded target and the conflict decided from it can never disagree.
   */
  setChunkPolicyConflict(
    fabFileId: string,
    chunkedPassageTokenTarget: number,
    conflict: FabFileChunkPolicyConflict | null
  ): Promise<void>;

  /**
   * Guarded-write ownership check for `chunkFabfile` (#1802 Phase 2): matches on BOTH `_id` and
   * `chunkClaimedAt` so a stale-claim takeover mid-run is caught via MongoDB's write-conflict
   * detection rather than a transaction-isolation READ (`withTransaction` configures no read
   * concern, and the competing CAS commits outside any transaction). `chunkClaimedAt` itself is
   * written back unchanged - the release CAS later matches on this run's exact original stamp - but
   * the write ALSO stamps `chunkClaimConfirmedAt` so it is never a byte-for-byte no-op: verified
   * against a real replica set that an update matching-and-writing only the SAME value can be
   * silently elided (no conflict raised, stale match succeeds), so a genuinely-changing field is
   * required for the write-conflict detection this depends on to actually fire. Returns `false`
   * when `chunkClaimedAt` no longer matches: a successor already reassigned this file's claim, and
   * the caller must abort before any further write.
   */
  confirmChunkClaim(fabFileId: string, chunkClaimedAt: Date): Promise<boolean>;

  /**
   * Find all files for a user.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to an array of files.
   */
  findByUserId(userId: string): Promise<IFabFileDocument[]>;

  /**
   * Sum the `fileSize` of every non-deleted file a user owns, via an aggregate
   * so no documents are hydrated. A missing or null `fileSize` counts as 0.
   * @param userId - The ID of the user.
   * @returns A promise that resolves to the total size in bytes.
   */
  sumFileSizeByUserId(userId: string): Promise<number>;

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
       * One arm per lake's membership scope, matching the whole-lake writes exactly. Server-
       * supplied only: each scope names the creator whose OWNED files its prefix arm matches, so
       * it must never be read from request input.
       */
      lakeMemberships?: DataLakeMembershipScope[];
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
   * Count a user's live files carrying one tag. Matches the WHOLE name, case-insensitively - a
   * `test` tag does not count files tagged `testing`. Excludes soft-deleted files, unlike the
   * write paths that keep tag names in step.
   */
  countByUserIdAndTag(userId: string, tag: string): Promise<number>;

  /**
   * Count the number of files by tag for a user. Widens to shared/group/data-lake files when
   * options are supplied. `excludePersonalShares` additionally drops a file merely shared 1:1
   * with the user - see buildOwnershipConditions (packages/database) for the full why and which
   * kind of caller should or should not opt in.
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
      excludePersonalShares?: boolean;
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
   * Count unique files per root tag namespace for a user. GET /api/files/tags/counts calls
   * countFilesByTagForUser twice with two different scopes; this must move in lockstep with
   * that route's NARROWED (excludePersonalShares:true) call specifically, or a namespace's size
   * disagrees with its tag count. Omitting the scope counts owned files only.
   */
  countUniqueFilesByNamespaceForUser(
    userId: string,
    options?: {
      userGroups?: string[];
      dataLakeTags?: string[];
      dataLakeTagPrefixes?: string[];
      scopedTagPrefixes?: string[];
      excludePersonalShares?: boolean;
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
   * answer destructively (the unarchive dedup soft-deletes, recoverably, the losing copy) or by
   * skipping a caller's upload, and every re-upload path that matters writes the meta-tag, so
   * admitting a prefix match here would risk the wrong file for no gain.
   */
  findByContentHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  /**
   * Files in a lake whose SERVER-VERIFIED extracted-text hash matches (META-TAG ONLY, mirroring
   * findByContentHashesInDataLake). The acquisition queue's "the lake already holds this text"
   * check (#1671): `serverTextHash` is stamped by the admission contract for every door, where
   * `contentHash` is written by only the two presigned-URL uploads and never verified. Files that
   * have not chunked yet carry no hash and so cannot match - a miss here means "not known to be
   * present", never "known absent".
   */
  findByServerTextHashesInDataLake(hashes: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  /**
   * Whether ONE named file is still a member of a lake: same META-TAG scope as
   * findByServerTextHashesInDataLake, not deleted and not archived - but NOT filtered on `status`,
   * unlike every hash-keyed sibling. The acquisition queue asks this about the file a prior approval
   * admitted (#1671), where a stored `approved` status alone would keep answering "the lake already
   * holds this" long after ordinary file management removed the file, leaving the source permanently
   * unproposable with no human ever seeing it again.
   *
   * The `status` divergence is deliberate: the caller already knows a human approved THIS file, so a
   * file still mid-ingest ('pending', before the S3 ObjectCreated handler completes it) is held, not
   * absent. Excluding it would re-open the source for the whole approval->ingest window and let a
   * reviewer be handed a second card for content already on its way in.
   */
  isLiveDataLakeMember(fabFileId: string, datalakeTag: string): Promise<boolean>;
  /**
   * Files in a lake ingested from any of the given Google Drive file ids (META-TAG ONLY,
   * mirroring findByContentHashesInDataLake). driveFileId is the Drive re-sync dedup key:
   * it is stable across edits where contentHash is not, so it decides create-vs-skip-vs-update.
   */
  findByDriveFileIdsInDataLake(driveFileIds: string[], datalakeTag: string): Promise<IFabFileDocument[]>;
  /**
   * Every file a given Drive connection has ingested into a lake (META-TAG ONLY, mirroring
   * findByDriveFileIdsInDataLake). This is the basis re-sync diffs the fresh folder walk against:
   * a stored file whose driveFileId is absent from the walk was DELETED from the folder, and one
   * whose driveMd5Checksum/driveModifiedTime moved was EDITED - neither detectable from the walk
   * alone. Scoped to the connection so a re-sync only reconciles the files it owns.
   */
  findByDriveConnectionIdInDataLake(driveConnectionId: string, datalakeTag: string): Promise<IFabFileDocument[]>;
  markFailedIfNotAlready(fabFileId: string, errorMessage: string): Promise<boolean>;
  /**
   * Guarded partial-progress write for the multi-message vectorize fan-out: applies only if the
   * stored count is not already higher and the file has not been stamped terminal, so a stale
   * rollup can never regress a count or reopen `isVectorizing` on a settled file. Returns true
   * if this call advanced the file.
   */
  advanceVectorizeProgress(
    fabFileId: string,
    vectorizedChunkCount: number,
    rollup?: { embeddedChunkCount: number; embeddedCharCount: number }
  ): Promise<boolean>;

  // ── Data lake lifecycle. Scoped by DataLakeMembershipScope - the lake's meta-tag OR a
  // fileTagPrefix match on a file the lake's creator OWNS. See buildDataLakeMembershipFilter
  // in @bike4mind/database for the rule and why the prefix arm needs the ownership conjunct. ──

  /**
   * Authoritative lake stats recomputed from source records via an aggregate (NOT
   * find().length). Counts only live files (not archived, not deleted).
   */
  computeDataLakeStats(
    scope: DataLakeMembershipScope
  ): Promise<{ fileCount: number; totalSizeBytes: number; totalChunkedChars: number }>;
  /**
   * Per-member health rollups (#1666) for a lake, read from FabFile documents only (never the chunk
   * collection). Raw numbers the pure evaluator grades; char fields stay `null` when unmeasured.
   * Members with no chunks are excluded. `limit` fetches one extra row so the caller can detect and
   * report overflow instead of silently truncating.
   */
  findDataLakeHealthMembers(
    scope: DataLakeMembershipScope,
    limit?: number
  ): Promise<
    Array<{
      fabFileId: string;
      fileName?: string;
      chunkCount: number;
      // vectorizedChunkCount + error drive the in-flight vs settled decision in the pure evaluator;
      // omitting them here would silently disable that gate (rows arrive without them -> treated as
      // settled), re-arming the mid-ingest "0% reachable" bug at the type level. Keep in sync.
      vectorizedChunkCount: number | null;
      error: string | null;
      // Third terminal-stall input, same keep-in-sync rule as the two above: the convergence kill
      // switch stalls a file via `chunkStallReason` without ever setting `error`.
      chunkStallReason: ChunkStallReason | null;
      // Fourth in-flight input, same keep-in-sync rule: a file whose passages a wave just reset is
      // chunkless with no error and no stall reason, so this stamp is the only thing that tells
      // "rebuilding" from "never had passages" (#1939).
      chunkRebuildRequestedAt: Date | null;
      chunkedCharCount: number | null;
      maxChunkCharLength: number | null;
      embeddedChunkCount: number | null;
      embeddedCharCount: number | null;
    }>
  >;
  /**
   * Per-member facts owner-triggered convergence (#1681) decides on. Deliberately NOT
   * `findDataLakeHealthMembers`: convergence asks a different question and needs three fields health
   * does not (the owner `userId` to re-enqueue under, the #1662 stamped chunk target, and the file's
   * lake meta-tags for the cross-lake oscillation check), while needing none of health's char sums.
   * Same membership + liveness filter, and the same `isChunking: {$ne: true}` exclusion
   * `findChunkedFilesByScope` uses so a wave cannot select a file a worker is already mid-run on.
   *
   * `limit` fetches one extra row so the caller can report the scan as partial rather than silently
   * planning against a truncated lake - a truncated denominator would understate `changeShare` and
   * could slip a mass rewrite past the bulk-change guard.
   */
  findLakeConvergenceMembers(
    scope: DataLakeMembershipScope,
    limit?: number
  ): Promise<
    Array<{
      fabFileId: string;
      userId: string;
      fileName?: string;
      tags: { name: string }[];
      chunkCount: number;
      // Same keep-in-sync rule as findDataLakeHealthMembers: vectorizedChunkCount, error and
      // chunkStallReason together decide settled vs in-flight, and a row arriving without one
      // silently disables that arm of the decision rather than failing.
      vectorizedChunkCount: number | null;
      error: string | null;
      chunkStallReason: ChunkStallReason | null;
      /** See findDataLakeHealthMembers - the pending-rebuild stamp is an in-flight input here too. */
      chunkRebuildRequestedAt: Date | null;
      maxChunkCharLength: number | null;
      chunkedPassageTokenTarget: number | null;
    }>
  >;
  /**
   * One page of a lake's LIVE members for the lake-memory extraction producer, ascending by `_id`,
   * projecting only the three fields that producer reads. Live-only and bounded in the database, unlike
   * `findIdsByDataLakeTag` above, which reports every member the lake ever had.
   *
   * `after` is a keyset boundary, and an unparseable one is ignored rather than throwing. Ask for one
   * row past the cap to tell "the lake continues" from "the slice filled exactly" without a count
   * query. See the implementation for why each of those is load-bearing.
   */
  findLakeMemoryExtractionMembers(
    scope: DataLakeMembershipScope,
    options: { after?: string | null; limit: number }
  ): Promise<Array<{ fabFileId: string; fileName?: string; tags: { name: string }[] }>>;
  /**
   * One page of file ids that have chunks but no `chunkedCharCount` (missing or nulled by a
   * content rewrite), ascending by `_id` - the char-length backfill's phase-2 cursor.
   */
  findFileIdsMissingChunkedCharCount(options?: { limit?: number; afterFileId?: string }): Promise<string[]>;
  /** Stamp a file's recomputed `chunkedCharCount` - the char-length backfill's phase-2 write. */
  setChunkedCharCount(id: string, chunkedCharCount: number): Promise<void>;
  /**
   * One page of file ids with chunks but missing the lake-health (#1666) rollups (keyed by absent
   * `maxChunkCharLength`), ascending by `_id` - the health backfill's phase-2 cursor.
   */
  findFileIdsMissingChunkRollups(options?: { limit?: number; afterFileId?: string }): Promise<string[]>;
  /** Stamp all four recomputed chunk-derived rollups together - the health backfill's phase-2 write. */
  setChunkRollups(
    id: string,
    rollups: {
      chunkedCharCount: number;
      maxChunkCharLength: number;
      embeddedChunkCount: number;
      embeddedCharCount: number;
    }
  ): Promise<void>;
  /**
   * Live, already-chunked files in the lake, as {id, userId} - the input set for under-chunked
   * detection. userId is the file OWNER, needed to re-enqueue the chunk job under the same
   * identity the original ingest used. Excludes deleted/archived/still-pending files, and files
   * already claimed and in-flight (isChunking) so a concurrent wave can't re-select them.
   */
  findChunkedFilesByScope(scope: DataLakeMembershipScope): Promise<{ id: string; userId: string }[]>;
  /**
   * The lake's files whose passages a HALTED convergence wave deleted, as {id, userId}. Chunkless
   * with no error, so they match neither `findChunkedFilesByScope` (needs chunked:true) nor
   * `countFailedFilesByScope` (needs a non-empty error) - which is how they stayed invisible to
   * "Rebuild passages", the one affordance an owner would actually reach for to repair them. They
   * are identified by `chunkStallReason`, the same marker health, convergence and the
   * retrieval withhold key on, OR by a `chunkRebuildRequestedAt` stamp older than
   * REBUILD_PENDING_STALE_MS - a rebuild nothing ever committed, which is what a producer killed
   * between the reset and the sends leaves behind (#1939). Same in-flight exclusion as
   * `findChunkedFilesByScope`.
   */
  findConvergencePausedFilesByScope(scope: DataLakeMembershipScope): Promise<{ id: string; userId: string }[]>;
  /**
   * Reset the chunk/vector flags on a set of files so a re-enqueued chunk job actually re-chunks
   * instead of hitting the "already chunked" guard. Clears `error` too - a file that chunked then
   * failed vectorization would otherwise be stranded (chunked:false + stale error is invisible to
   * both re-detection and the rescue sweep). Shared by the bulk rebuild wave and the per-file
   * reprocess route so the two cannot drift. Returns the number modified.
   *
   * Preconditioned on `isChunking: {$ne: true}`: the reset WRITES isChunking:false, so without it a
   * reset would release a live worker's lease and let a second worker into chunkFabfile's
   * delete-then-insert. Returns the ids actually reset, so the caller enqueues exactly what changed.
   *
   * Stamps `chunkRebuildRequestedAt` in the SAME write (#1939), so the state this creates is never
   * unmarked: the send that follows can fail, and the producer can die before it, without leaving a
   * chunkless file that no reader can tell from an image.
   *
   * Does NOT touch `notes` (#2016) - that is the owner's own text, and this reset used to blank it on
   * every rebuild wave and every per-file reprocess. It does clear the two machine-written markers
   * (`chunkStallReason`, `noExtractableTextAt`), which is what makes reprocess the documented way
   * back in for a file the rescue sweep has written off.
   */
  resetChunkStateByIds(ids: string[]): Promise<string[]>;
  /**
   * Count the lake's files whose re-chunk failed (error set, no chunks) - invisible to both the
   * under-chunked detection and the rescue sweep, so surfaced separately so a manager can tell
   * "rebuild done" from "some files gave up".
   */
  countFailedFilesByScope(scope: DataLakeMembershipScope): Promise<number>;
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
  // freeing a prefix-sharing sibling's independently-archived files. `unarchiveByDataLakeTag` and
  // `findArchivedByDataLakeTag` use this same equality bound over the WHOLE membership filter, not
  // just the prefix arm - a meta-tag match is not exempt, because `addFileToLake` lets one file
  // carry more than one lake's meta-tag with no exclusivity check, so a meta-tagged row can belong
  // to a co-owning lake's own archive just as a prefix-tagged row can belong to a sibling's.

  /**
   * Soft-archive (reversible) all live member files, stamped `at`. Returns affected count.
   * Omitting `at` still writes a real per-row timestamp - it is orphaned (no lake names it), not
   * absent. See archiveDataLake's `hasUnstampedArchive` guard for when that's intentional.
   */
  archiveByDataLakeTag(scope: DataLakeMembershipScope, at?: Date): Promise<number>;
  /**
   * Reverse archive for member files stamped `stampedAt`, by equality - a sibling or a co-owning
   * lake's own differently-stamped member is never freed. `stampedAt` omitted unarchives
   * unbounded, for a lake archived before `filesArchivedAt` existed.
   */
  unarchiveByDataLakeTag(scope: DataLakeMembershipScope, stampedAt?: Date): Promise<number>;
  /**
   * Archived member files stamped `stampedAt` - used by the unarchive dedup pass. Omitting
   * `stampedAt` matches every archived row, same as before this parameter existed.
   */
  findArchivedByDataLakeTag(scope: DataLakeMembershipScope, stampedAt?: Date): Promise<IFabFileDocument[]>;
  /**
   * Existence-only probe, unbounded by any stamp (unlike findArchivedByDataLakeTag) - a caller
   * deciding whether to claim a fresh stamp needs to know if ANY member is already archived,
   * stamped or not.
   *
   * EXCLUSIVE means the row carries no OTHER lake's membership meta-tag: a co-tagged row is
   * whichever co-owning lake's stamp is on it, not this lake's un-restorable orphan, so counting
   * it here would leave this lake permanently unstamped and its own later unarchive unbounded.
   * Says nothing about a prefix-ARM collision, which carries no lake attribution at all (#1729).
   */
  hasArchivedMemberExclusiveToDataLakeTag(scope: DataLakeMembershipScope): Promise<boolean>;
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
