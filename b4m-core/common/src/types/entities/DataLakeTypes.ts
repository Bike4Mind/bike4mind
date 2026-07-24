import { IBaseRepository, type IMongoDocument } from '.';

// ── Data Lake Status ────────────────────────────────────────────────────────

/**
 * Lake lifecycle. Stable states (draft/active/archived/deleted) plus transitional
 * states (archiving/restoring/deleting) that exist to drive UI and make a crashed
 * mid-operation observable. draft -> active is one-way and happens implicitly on
 * first batch creation.
 */
export type DataLakeStatus = 'draft' | 'active' | 'archiving' | 'archived' | 'restoring' | 'deleting' | 'deleted';

/** Stable (non-transitional) lake statuses. */
export const DATA_LAKE_STABLE_STATUSES: DataLakeStatus[] = ['draft', 'active', 'archived', 'deleted'];

/** Per-batch policy for files whose content hash already exists in the lake. */
export type ConflictResolution = 'skip' | 'update' | 'duplicate';

/**
 * The acting principal, resolved from auth - never from the request body/query.
 * Used by the single lake access gate (assertLakeAccess).
 */
export interface AccessContext {
  userId: string;
  isAdmin: boolean;
  userTags: string[];
  organizationId?: string;
  /**
   * Caller's resolved entitlement keys (subscription- + tag-derived), resolved app-side
   * and injected here - core never imports the resolver or the Subscription model (same
   * seam as the retrieval path's `DataLakeAccessContext.entitlementKeys`). The management
   * gates grant on EITHER a matching `requiredUserTag` OR a matching `requiredEntitlement`.
   * Optional - absent -> tag-only matching (back-compat for any caller not threading it).
   *
   * Intentionally distinct from `DataLakeAccessContext` (retrieval): this type also carries
   * `userId`/`isAdmin`/`organizationId` for the owner/org bypass that retrieval doesn't need.
   */
  entitlementKeys?: string[];
}

// ── Data Lake ───────────────────────────────────────────────────────────────

export interface IDataLake {
  /** Human-readable name, e.g. "Sales Intelligence" */
  name: string;
  /** URL-safe unique identifier, e.g. "acme-sales" */
  slug: string;
  /** Optional description of the data lake's purpose and contents */
  description?: string;
  /** Tag prefix for all files in this data lake, must end with ":" (e.g. "acme:") */
  fileTagPrefix: string;
  /** Auto-computed meta-tag: "datalake:<slug>" */
  datalakeTag: string;
  /** User must have this tag to access the data lake's files. If absent, all authenticated users can access. */
  requiredUserTag?: string;
  /**
   * Generic capability: user must hold this entitlement key (e.g. "<product>:pro") to
   * access the lake's files, evaluated against the caller's RESOLVED entitlement keys
   * (subscription-derived + tag-derived). Independent of `requiredUserTag` - access is
   * granted if the user satisfies ANY declared requirement; a lake declaring neither is
   * public. Values are namespaced (must contain ":") and stored normalized (lowercase).
   * Product-neutral: any lake may set it.
   */
  requiredEntitlement?: string;
  /** User who created this data lake */
  createdByUserId: string;
  /** Organization scope (optional - if set, only org members can manage) */
  organizationId?: string;
  /**
   * Public opt-in (default false): when true the lake is directory-listed and readable by
   * ANY authenticated user, across all orgs - it bypasses the org prerequisite and the
   * Private-by-default rule. The entitlement/tag gate is STILL respected (defense in depth),
   * but publishing a gated lake is refused at the write path (setLakeVisibility), so a public
   * lake is normally gate-less/open. Owner/admin management is unchanged. Mirrors the tri-state
   * `LakeVisibility`: private (no org, not public) | organization (org-scoped) | public.
   */
  isPublic?: boolean;
  /** Whether this data lake is active or archived */
  status: DataLakeStatus;
  /** Cached file count (updated on upload/delete) */
  fileCount?: number;
  /** Cached total size in bytes (updated on upload/delete) */
  totalSizeBytes?: number;
  /** Last time files were synced/uploaded to this data lake */
  lastSyncAt?: Date;
}

export interface IDataLakeDocument extends IDataLake, IMongoDocument {}

export interface IDataLakeRepository extends IBaseRepository<IDataLakeDocument> {
  /**
   * Resolve a lake by slug. Slug is unique only per scope (organizationId), so pass
   * the caller's org to disambiguate: the caller's own-org lake is preferred, falling
   * back to an org-less lake with that slug. Without an org, only org-less lakes match.
   */
  findBySlug(slug: string, organizationId?: string): Promise<IDataLakeDocument | null>;
  /** Resolve a lake by its globally-unique join meta-tag (`datalake:<slug>` / `datalake:<org>:<slug>`). */
  findByDatalakeTag(datalakeTag: string): Promise<IDataLakeDocument | null>;
  findActiveByUserTags(userTags: string[]): Promise<IDataLakeDocument[]>;
  /**
   * Entitlement-aware variant of `findActiveByUserTags`: active lakes the user can reach by
   * a matching `requiredUserTag`, a matching `requiredEntitlement` (against the caller's
   * resolved entitlement keys), or - for a gateless ORG lake - membership in its org. Plus
   * the caller's OWN lakes (owner bypass). Mirrors the HTTP path's `findAccessible`.
   *
   * `organizationId` is the hard org prerequisite: org-less lakes stay reachable cross-org
   * (curated opti/help); an org-scoped lake only resolves for a caller in that org.
   *
   * `userId` is the owner bypass + the Private-by-default rule: a lake with NO org and NO
   * gate is owner-only (not world-readable). Supply it on every user-facing retrieval call;
   * omit only for owner-agnostic lookups (then gateless org-less lakes match no one).
   */
  findActiveByUserTagsAndEntitlements(
    userTags: string[],
    entitlementKeys: string[],
    organizationId?: string | null,
    userId?: string | null
  ): Promise<IDataLakeDocument[]>;
  findByOrganizationId(orgId: string): Promise<IDataLakeDocument[]>;
  /**
   * Datastore-side accessibility filter - owner OR (org-match AND tag-match).
   * The org and tag constraints are BOTH required for a non-owner: a tag-holder in
   * a different org is excluded. Defaults to the active+draft statuses.
   */
  findAccessible(
    ctx: AccessContext,
    opts?: { statuses?: DataLakeStatus[]; includePublic?: boolean }
  ): Promise<IDataLakeDocument[]>;
  /** Persist recomputed stats (source via IFabFileRepository.computeDataLakeStats). */
  setStats(id: string, stats: { fileCount: number; totalSizeBytes: number }): Promise<IDataLakeDocument | null>;
}

// ── Data Lake Batch ─────────────────────────────────────────────────────────

export type BatchFileStatus = 'pending' | 'uploaded' | 'chunking' | 'vectorizing' | 'complete' | 'failed' | 'skipped';

/** Non-terminal batch statuses - the ones the read-time reconciler may force to terminal. */
export const BATCH_NON_TERMINAL_STATUSES: BatchStatus[] = ['preparing', 'uploading', 'processing'];

/** Terminal batch statuses - no further increments expected once reached. */
export const BATCH_TERMINAL_STATUSES: BatchStatus[] = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

export type BatchStatus =
  'preparing' | 'uploading' | 'processing' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

/**
 * Why a batch reached a terminal status, when that isn't the normal counter-driven
 * completion. Absent on a normally-finalized batch; 'reconciler' marks one the stuck-batch
 * reconciler force-terminated (so a forced terminal is distinguishable in observability).
 */
export type BatchCompletionReason = 'reconciler';

export interface IDataLakeBatchFile {
  fabFileId: string;
  fileName: string;
  relativePath?: string;
  contentHash?: string;
  status: BatchFileStatus;
  error?: string;
}

export interface IDataLakeBatch {
  dataLakeId: string;
  userId: string;
  status: BatchStatus;
  /** Per-batch dedup policy for files whose content hash already exists. Defaults to 'skip'. */
  conflictResolution?: ConflictResolution;

  // File tracking
  totalFiles: number;
  uploadedFiles: number;
  chunkedFiles: number;
  vectorizedFiles: number;
  failedFiles: number;
  failedFileNames?: string[];
  skippedFiles: number;

  // Size tracking
  totalSizeBytes: number;
  uploadedSizeBytes: number;

  // File manifest
  files: IDataLakeBatchFile[];

  // Taxonomy snapshot (the tags applied to files in this batch)
  appliedTags: { name: string; strength: number }[];

  // Timing
  startedAt?: Date;
  completedAt?: Date;

  /** Set only when a terminal status was reached by something other than normal completion (e.g. 'reconciler'). */
  completionReason?: BatchCompletionReason;
}

export interface IDataLakeBatchDocument extends IDataLakeBatch, IMongoDocument {}

export type BatchCounterField = 'uploadedFiles' | 'chunkedFiles' | 'vectorizedFiles' | 'failedFiles' | 'skippedFiles';

export interface IDataLakeBatchRepository extends IBaseRepository<IDataLakeBatchDocument> {
  findActiveByUserId(userId: string): Promise<IDataLakeBatchDocument[]>;
  findActiveByDataLakeId(dataLakeId: string): Promise<IDataLakeBatchDocument[]>;
  /**
   * Global cross-user scan for the reconciler cron: non-terminal batches whose `updatedAt` is
   * older than `cutoff`, oldest-first. `limit` caps a huge backlog per run so the cron stays
   * inside its Lambda timeout; the sweep is idempotent so any residue is picked up next run.
   * Served by the `{ status: 1, updatedAt: 1 }` index.
   */
  findStuck(cutoff: Date, limit?: number): Promise<IDataLakeBatchDocument[]>;
  updateFileStatus(batchId: string, fabFileId: string, status: BatchFileStatus, error?: string): Promise<void>;
  /**
   * Append manifest entries to a batch atomically ($push). Called as files are
   * created (presigned-URL issuance) so the manifest is populated incrementally.
   */
  appendFiles(batchId: string, files: IDataLakeBatchFile[]): Promise<void>;
  /**
   * Atomically claim a manifest file by transitioning it from one of `from` to
   * `to`. Returns true only if THIS call won the transition - the redelivery-safety
   * primitive: a re-delivered message loses the claim and returns false, so the
   * caller skips the counter increment.
   */
  claimFileStatus(batchId: string, fabFileId: string, from: BatchFileStatus[], to: BatchFileStatus): Promise<boolean>;
  incrementCounter(batchId: string, field: BatchCounterField, amount?: number): Promise<IDataLakeBatchDocument | null>;
  /**
   * Guarded terminal transition: set the batch terminal only if it is still
   * non-terminal. Returns the post-update doc to the single winner, null to losers,
   * so completion/finalization work runs exactly once.
   */
  markTerminalIfActive(
    batchId: string,
    status: Extract<BatchStatus, 'completed' | 'completed_with_errors' | 'failed' | 'cancelled'>,
    completionReason?: BatchCompletionReason
  ): Promise<IDataLakeBatchDocument | null>;
  /**
   * Guarded non-terminal transition: set the batch to a still-in-flight status only if it
   * has not already reached a terminal state, so a client-driven 'processing' flip can never
   * resurrect a batch the pipeline finalized first.
   */
  setStatusIfActive(
    batchId: string,
    status: Extract<BatchStatus, 'preparing' | 'uploading' | 'processing'>
  ): Promise<IDataLakeBatchDocument | null>;
}

// ── AI Taxonomy Inference ───────────────────────────────────────────────────

export interface TaxonomyCategory {
  /** Full tag name, e.g. "legal:type:contract" */
  tagName: string;
  /** Human-readable description */
  description: string;
  /** AI confidence score (0.0-1.0) */
  confidence: number;
  /** Which folder paths map to this tag */
  matchingFolders: string[];
}

export interface TaxonomyFileAssignment {
  relativePath: string;
  suggestedTags: { name: string; strength: number }[];
}

export interface InferTaxonomyResponse {
  suggestedPrefix: string;
  suggestedName: string;
  categories: TaxonomyCategory[];
  fileAssignments: TaxonomyFileAssignment[];
}

// ── Sync Delta ──────────────────────────────────────────────────────────────

export interface SyncDeltaNewFile {
  relativePath: string;
  fileName: string;
  contentHash: string;
}

export interface SyncDeltaChangedFile {
  relativePath: string;
  fileName: string;
  contentHash: string;
  existingFileId: string;
  existingHash: string;
}

export interface SyncDeltaRemovedFile {
  fileId: string;
  fileName: string;
  contentHash: string;
}

export interface SyncDelta {
  newFiles: SyncDeltaNewFile[];
  changedFiles: SyncDeltaChangedFile[];
  removedFiles: SyncDeltaRemovedFile[];
  unchangedFiles: { fileId: string; fileName: string }[];
}
