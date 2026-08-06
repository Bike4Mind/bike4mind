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
  /**
   * Optional per-lake system prompt, so a lake can carry its own answering instructions.
   * Not yet consumed: a later PR (#843) injects it as a labeled system message whenever this
   * lake is active in a chat turn, refining behavior WITHIN the org prompt (which stays
   * authoritative on conflict). Editable only by the lake creator or an admin (canManageLake);
   * uncapped, matching the other system prompts in the codebase. Absent/empty = no per-lake prompt.
   */
  systemPrompt?: string;
  /** Tag prefix for all files in this data lake, must end with ":" (e.g. "acme:") */
  fileTagPrefix: string;
  /** Auto-computed meta-tag: "datalake:<slug>" */
  datalakeTag: string;
  /**
   * User must have this tag to access the data lake's files. Absent/empty means no tag gate -
   * NOT world-readable: access then falls back to visibility (owner-only, org, or public) per
   * Private-by-default. Set at create, and changeable or removable later (updateDataLake takes
   * '' as the clear sentinel).
   */
  requiredUserTag?: string;
  /**
   * Generic capability: user must hold this entitlement key (e.g. "<product>:pro") to
   * access the lake's files, evaluated against the caller's RESOLVED entitlement keys
   * (subscription-derived + tag-derived). Independent of `requiredUserTag` - access is
   * granted if the user satisfies ANY declared requirement; a lake declaring neither is
   * ungated, which is not the same as public (see `requiredUserTag`). Values are namespaced
   * (must contain ":") and stored normalized (lowercase). Product-neutral: any lake may set it.
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
  /**
   * The exact `deletedAt` stamp phase-1 delete wrote on this lake's members, so restore can
   * un-delete that batch and nothing else. Not a time window: it is matched by EQUALITY, which is
   * what keeps a file the creator deleted independently - before OR during the deleted window -
   * from riding back in. Claimed set-if-unset, so two overlapping teardowns agree on one stamp
   * instead of the loser recording a mark no row carries; restore clears it.
   *
   * Absent on a lake torn down before this field existed, which restores unbounded (the old
   * behavior) rather than restoring nothing.
   */
  filesDeletedAt?: Date | null;
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
   * Datastore-side accessibility filter - owner OR public OR (org-match AND requirement-match
   * AND not-private). The org and requirement constraints are BOTH required for a non-owner: a
   * tag/entitlement-holder in a different org is excluded, and a lake with no org and no gate
   * stays owner-only. Defaults to the active+draft statuses.
   */
  findAccessible(
    ctx: AccessContext,
    opts?: { statuses?: DataLakeStatus[]; includePublic?: boolean }
  ): Promise<IDataLakeDocument[]>;
  /**
   * The discover/browse catalog: active, PUBLIC, gate-less lakes for the public-browse surface,
   * independent of any caller identity (the catalog is the same for everyone). Only gate-less
   * lakes qualify - a lake that acquired a `requiredUserTag`/`requiredEntitlement` after being
   * published is no longer open to all, so it must not surface in a browse-everyone view (this
   * mirrors the both-blank requirement arm on the retrieval/list paths). `search` matches name
   * or description case-insensitively. Returns one page plus the unpaged `total` for the UI.
   */
  findPublicLakes(opts?: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ lakes: IDataLakeDocument[]; total: number }>;
  /** Persist recomputed stats (source via IFabFileRepository.computeDataLakeStats). */
  setStats(id: string, stats: { fileCount: number; totalSizeBytes: number }): Promise<IDataLakeDocument | null>;
  /**
   * Claim `filesDeletedAt` for a phase-1 teardown: writes `at` only if the lake carries no stamp,
   * and returns the stamp now in force - the existing one when a concurrent teardown or a crashed
   * prior attempt already claimed it. Callers must sweep with the RETURNED value, not their own,
   * or they stamp rows under a mark the lake does not name. Null means no stamp is in force: the
   * lake vanished, or a restore cleared it between the claim and the fallback read - so a null
   * caller sweeps unmarked and must say so, since that lake then restores unbounded.
   */
  claimFilesDeletedAt(id: string, at: Date): Promise<Date | null>;
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

/**
 * Background AI-tagging phase for a batch, orthogonal to `BatchStatus`. `BatchStatus` already
 * means "ingest (upload/chunk/vectorize) is done" and terminal-vs-not there is load-bearing for
 * the reconciler/list/UI; layering post-ingest AI analysis onto it would make an already-
 * "completed" batch look reopened. `'none'` covers both "never opted in" and append-mode
 * batches (which never offer the opt-in at all).
 */
export type TaxonomyStatus = 'none' | 'queued' | 'analyzing' | 'ready' | 'applying' | 'applied' | 'failed';

/** Non-terminal taxonomy phases - the ones the stuck-job reconciler may force to 'failed'. */
export const TAXONOMY_NON_TERMINAL_STATUSES: TaxonomyStatus[] = ['queued', 'analyzing', 'applying'];

/**
 * Every phase the Data Lakes list needs to show a badge for: still running, OR finished and
 * awaiting the user (ready to review / failed and dismissible). Excludes 'none' (never opted
 * in) and 'applied' (already resolved, nothing left to surface). Includes 'applying' so a
 * batch stuck there (e.g. an apply request that errored or hit the Lambda timeout mid-write)
 * stays visible to the list and the fast read-time reconciler instead of only being reachable
 * by the daily cron sweep.
 */
export const TAXONOMY_ATTENTION_STATUSES: TaxonomyStatus[] = ['queued', 'analyzing', 'ready', 'applying', 'failed'];

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

  /** Opted into background AI tag suggestion at batch-create time. Never true in append mode. */
  wantsTaxonomy?: boolean;
  /** Background AI-tagging phase; see `TaxonomyStatus`. */
  taxonomyStatus?: TaxonomyStatus;
  /** When the current 'queued'/'analyzing'/'applying' phase started - the stuck-job reconciler's cutoff clock. */
  taxonomyStartedAt?: Date;
  /**
   * The AI's suggested categories/assignments, once `taxonomyStatus` is 'ready' - already
   * sanitized (see sanitizeCategories/sanitizeFileAssignments in utils/dataLakeTaxonomy.ts)
   * against the batch's already-fixed tag prefix, so the review panel and the apply
   * endpoint both read one trusted shape. No `suggestedPrefix`/`suggestedName` here: by the
   * time analysis runs (post-upload), the lake's name and prefix are already set.
   */
  taxonomySuggestions?: TaxonomyTagSet;
  /** Human-readable failure reason, set alongside `taxonomyStatus: 'failed'`. */
  taxonomyError?: string;
}

export interface IDataLakeBatchDocument extends IDataLakeBatch, IMongoDocument {}

/**
 * Shape returned by the list-surface/reconciler-input queries below, which all project out both
 * the per-file manifest and `taxonomySuggestions.fileAssignments` for response-size reasons -
 * neither is genuinely present at runtime, not just empty, so this type (rather than
 * `IDataLakeBatchDocument`) is what should flow to any consumer of those results, both server-
 * and client-side.
 */
export type IDataLakeBatchSummary = Omit<IDataLakeBatchDocument, 'files' | 'taxonomySuggestions'> & {
  taxonomySuggestions?: Omit<TaxonomyTagSet, 'fileAssignments'>;
};

export type BatchCounterField = 'uploadedFiles' | 'chunkedFiles' | 'vectorizedFiles' | 'failedFiles' | 'skippedFiles';

export interface IDataLakeBatchRepository extends IBaseRepository<IDataLakeBatchDocument> {
  findActiveByUserId(userId: string): Promise<IDataLakeBatchSummary[]>;
  findActiveByDataLakeId(dataLakeId: string): Promise<IDataLakeBatchSummary[]>;
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
  /**
   * Guarded taxonomy-phase transition: set `taxonomyStatus` only if it is still one of `from`,
   * so a redelivered queue message or a race between the reconciler and a live worker can only
   * let one caller win. `extra` carries fields that travel with the transition (e.g.
   * `taxonomyStartedAt` on `-> queued`, `taxonomySuggestions`/`taxonomyError` on the terminal ones).
   */
  setTaxonomyStatusIfActive(
    batchId: string,
    from: TaxonomyStatus[],
    to: TaxonomyStatus,
    extra?: Partial<Pick<IDataLakeBatch, 'taxonomyStartedAt' | 'taxonomySuggestions' | 'taxonomyError'>>
  ): Promise<IDataLakeBatchDocument | null>;
  /**
   * Global cross-user scan for the taxonomy stuck-job reconciler: batches whose `taxonomyStatus`
   * is still non-terminal and whose `taxonomyStartedAt` is older than `cutoff`, oldest-first.
   * Mirrors `findStuck`'s shape, served by the `{ taxonomyStatus: 1, updatedAt: 1 }` index.
   */
  findStuckTaxonomy(cutoff: Date, limit?: number): Promise<IDataLakeBatchDocument[]>;
  /**
   * Batches whose `taxonomyStatus` is in `TAXONOMY_ATTENTION_STATUSES` - running or awaiting
   * review/dismissal. Deliberately independent of `status` (ingest phase): the common case is
   * an already-'completed' batch whose taxonomy phase is still 'analyzing', which
   * findActiveByUserId's status-based filter would miss entirely. `files` is excluded, and the
   * result is capped (default 500, overridable - see the class implementation for why) to the
   * most-recently-updated - sized for the list-response use case, NOT suitable as reconciler
   * input (see `findActiveTaxonomyByUserId`).
   */
  findTaxonomyAttentionByUserId(userId: string, limit?: number): Promise<IDataLakeBatchSummary[]>;
  /**
   * Per-user counterpart to `findStuckTaxonomy`: the full non-terminal (`queued`/`analyzing`/
   * `applying`) taxonomy working set for one user, unbounded and unsorted. Use this - not
   * `findTaxonomyAttentionByUserId` - as reconciler input, since that method's capped/sorted
   * result would silently exclude exactly the stale, stuck batches a reconciler exists to find.
   */
  findActiveTaxonomyByUserId(userId: string): Promise<IDataLakeBatchSummary[]>;
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

// ── Taxonomy Tag Application ─────────────────────────────────────────────────
// Shared between the client wizard (formerly the taxonomy review step; now unused there) and
// the server-side post-upload apply path, so both compute applied tags with one
// implementation (see utils/dataLakeTaxonomy.ts in this package).

export interface TaxonomyTag {
  /** The editable part of the tag AFTER the shared prefix, e.g. "type:contract". */
  suffix: string;
  /** The full name inference assigned (incl. its original prefix) - the stable join key across edits. */
  originalName: string;
  /** Confidence/relevance score 0.0-1.0 */
  strength: number;
  /** How this tag was inferred */
  source: 'folder' | 'ai';
  /** Folder paths this tag covers; drives which files get it */
  matchingFolders: string[];
  /** Whether this tag has been soft-deleted/rejected by the reviewer */
  deleted: boolean;
}

/**
 * The portable subset of reviewed-taxonomy state `tagsForFile`/`appliedTagsForBatch` need to
 * compute applied tags. A caller with extra UI-only state (e.g. the old wizard's
 * `attempted`/`analyzing` flags) can pass a superset - only `tags`/`fileAssignments` are read.
 */
export interface TaxonomyTagSet {
  tags: TaxonomyTag[];
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
