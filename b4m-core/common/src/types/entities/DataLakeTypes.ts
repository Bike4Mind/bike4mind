import { IBaseRepository, type IMongoDocument } from '.';
import type { DataLakeGroundingMode } from '../../constants/dataLakes';
import type { ILakeUsageSummary } from './UsageEventTypes';

// ── Data Lake Status ────────────────────────────────────────────────────────

/**
 * Lake lifecycle. Stable states (draft/active/archived/deleted) plus transitional
 * states (archiving/restoring/deleting/purging) that exist to drive UI and make a crashed
 * mid-operation observable. draft -> active is one-way. It happens implicitly once the lake
 * holds its first member file (see `activateIfDraft` below), and unconditionally when an
 * archived or deleted lake is restored, which is how an empty lake can end up active.
 *
 * `purging` is the one transitional state that is NOT recoverable by retrying the same action:
 * it is claimed the moment a phase-2 hard delete is ACCEPTED (#1744), before the background
 * sweep runs, so that `listDeletedDataLakes` stops offering Restore on a lake whose
 * destruction is already irreversible. Everything else that reads `status` must treat it as
 * "going away", never as a lake to act on.
 */
export const DATA_LAKE_STATUSES = [
  'draft',
  'active',
  'archiving',
  'archived',
  'restoring',
  'deleting',
  'deleted',
  'purging',
] as const;

/**
 * Derived from the constant above, NOT a parallel union: the mongoose enum imports that same
 * constant, so a status added here reaches the schema by construction. A hand-maintained second
 * list would type-check either way (an annotation proves each entry is valid, never that all are
 * present) and then reject the write at runtime.
 */
export type DataLakeStatus = (typeof DATA_LAKE_STATUSES)[number];

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
  /**
   * Authoritative org membership (normalized string ids), resolved at context construction
   * from the organization documents' owner + users[] ACL (findMembershipOrgIds) - never from
   * user.organizationId, which is the "currently selected org" display preference and must
   * not be an authorization input (#1674). Empty array = member of no organization.
   */
  organizationIds: string[];
  /**
   * Orgs the caller holds admin RIGHTS in (billing owner / manager / appointed admin), resolved
   * app-side via `organizationRepository.findIdsWithAdminRights` and injected here (same pre-resolved
   * seam as `entitlementKeys`; core never imports the Organization model). An org admin may MANAGE any
   * lake scoped to one of these orgs - the org-manageable rung in `canManageLake`. Distinct from
   * `organizationIds` above: that set is MEMBERSHIP (which orgs the caller may READ), this one is
   * admin RIGHTS (which orgs the caller may MANAGE) - a member is not an admin. Neither is
   * `user.organizationId`, the selected-org display preference, which is never an authorization
   * input (#1674). Optional - absent -> no org-admin rung (back-compat).
   */
  administeredOrgIds?: string[];
  /**
   * Caller's resolved entitlement keys (subscription- + tag-derived), resolved app-side
   * and injected here - core never imports the resolver or the Subscription model (same
   * seam as the retrieval path's `DataLakeAccessContext.entitlementKeys`). The management
   * gates grant on EITHER a matching `requiredUserTag` OR a matching `requiredEntitlement`.
   * Optional - absent -> tag-only matching (back-compat for any caller not threading it).
   *
   * Intentionally distinct from `DataLakeAccessContext` (retrieval): this type also carries
   * `userId`/`isAdmin`/`organizationIds` for the owner/org bypass that retrieval doesn't need.
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
   * Injected RETRIEVAL-SCOPED: it rides only on turns that actually retrieved content from
   * this lake, on both channels - forced retrieval (KnowledgeRetrievalFeature) and the
   * model-driven knowledge tools (prependRetrievedLakePrompts) - resolved by
   * getAccessibleDataLakePrompts and rendered with the renderDataLakePromptSection defenses.
   * Injected only for TRUSTED actors (the lake's creator, or a member of the lake's
   * organization - see isTrustedForInjection); users reached via tag/entitlement grants read
   * the lake WITHOUT this prompt. The org prompt stays authoritative on conflict. Editable
   * only via canManageLake and withheld from non-managers by the server; uncapped, matching
   * the other system prompts in the codebase. Absent/empty = no per-lake prompt.
   */
  systemPrompt?: string;
  /**
   * Optional preferred registry system prompt for this lake, by `promptId` (e.g. 'triage_router').
   * When a session is created FOR this lake (see resolveLakeSessionDefaults), this seeds the
   * session's `systemPromptId` unless the caller set one explicitly - so a corpus ships with the
   * prompt it was tuned against, and the router's "pair it with a lake" precondition holds by
   * construction.
   *
   * DELIBERATELY DISTINCT from `systemPrompt` above, because the two are opposite kinds of thing:
   * `systemPrompt` is free-text answering guidance injected ADDITIVELY at request time (plural -
   * every trusted, retrieved lake contributes a block); this is a SINGULAR session-mode prompt id
   * that suppresses the generic identity prompt, so it is resolved ONCE at create time (a request-
   * time, multi-lake resolution would have no sound tie-break and would flicker the session's system
   * message turn to turn). Validated against the session-activatable allowlist at the write boundary.
   * Editor-only (see LAKE_FIELD_VISIBILITY); absent/empty = no preferred prompt.
   */
  preferredSystemPromptId?: string;
  /**
   * How this lake's attached corpus is grounded into a chat turn - a DELIBERATE product choice
   * (`inline` | `retrieve` | `auto-by-size`), not a side effect of who is asking. This exists
   * because inline-vs-retrieve otherwise falls out of a per-file CASL read: a lake OWNER gets the
   * corpus inlined while an entitlement-only READER matches no read arm and gets retrieval-only -
   * the same lake, opposite behavior. Resolved ONCE when a session is created FOR this lake
   * (resolveLakeSessionDefaults -> session.corpusGroundingMode) and enforced by the completion
   * path's corpus defer plan, which generalizes the size-only #1438 rule to honor this mode.
   *
   * Absent = the default (DEFAULT_DATA_LAKE_GROUNDING_MODE = 'retrieve'), applied at the resolver
   * so lakes predating this field ground the same as new ones. Editor-only (see
   * LAKE_FIELD_VISIBILITY): a reader gets its EFFECT, never reads the setting.
   */
  groundingMode?: DataLakeGroundingMode;
  /**
   * The chunk passage target in TOKENS this lake REQUIRES of its member files (#1662). This is a
   * CONSTRAINT, not an override: chunk policy is resolved at file-OWNER altitude (see the scoped
   * `DefaultChunkSize` setting), because chunks are keyed per FabFile and shared by every consumer
   * of that file. A file whose effective chunk target does not equal this - including a file tagged
   * into two lakes whose requirements disagree - is REPORTED as a conflict (see IFabFile.
   * chunkPolicyConflict), never silently re-chunked to satisfy one lake at another's or a
   * non-member's expense. Absent/`null` = the lake imposes no chunk requirement (the common case);
   * `null` is the explicit clear sentinel written by updateDataLake, undefined is never-set.
   */
  requiredPassageTokenTarget?: number | null;
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
  /**
   * The last principal to write this lake's CONFIGURATION - server-set from the authenticated
   * actor at the service boundary, never client input (it is absent from
   * UpdateDataLakeRequestInput, so secureParameters drops a supplied value). `createdByUserId`
   * never moves on an update, so without this nothing records WHO: `timestamps` advances
   * `updatedAt` and no field says by whom.
   *
   * Written by every CONFIG-write service - updateDataLake, setLakeVisibility,
   * transferLakeOwnership, and the archive/unarchive + delete/restore lifecycle pairs - so the
   * answer holds for the whole config surface, not just the metadata PUT. Lifecycle stamps only on
   * the TERMINAL transition, one stamp per operator action rather than one per intermediate hop.
   *
   * Deliberately NOT stamped: createDataLake already records its actor as createdByUserId, and a
   * lake nobody has reconfigured should read as exactly that rather than as self-updated; file
   * membership (addFileToLake/removeFileFromDataLake) changes the lake's CONTENT rather than its
   * configuration and is attributed per file; recomputeLakeStats is UNATTRIBUTED BY DESIGN rather
   * than operator-free (a tag edit, a file toggle or a batch completion drives it, and it can flip
   * status via activateIfDraft - it takes an optional actor only to attribute the config-change
   * event that flip emits, and deliberately never writes this stamp); the lake-memory
   * lease is genuine headless bookkeeping; and resetEmbeddingSpend moves a cost meter, not an
   * answering behavior. So this reads as "who last changed how this lake is configured", never
   * "who last touched this lake in any way".
   *
   * A stamp, not a history: it is overwritten by the next write and answers only "who last
   * touched this". Editor-only (see LAKE_FIELD_VISIBILITY). Absent on a lake nobody has
   * reconfigured - which includes both a newly created lake and one untouched since this field
   * existed; the two are indistinguishable here, and the config-change event is what separates them.
   */
  lastUpdatedByUserId?: string;
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
  /**
   * Per-lake opt-in (default false) to logging the natural-language QUERY TEXT behind a
   * retrieval, alongside the always-on access event (see LakeAccessEventModel). Off by default
   * because query text is simultaneously the most useful field for a customer and the most
   * sensitive - without this gate the audit log would become a second copy of the corpus plus a
   * record of everyone's questions. Read as the caller's INTENT: the actual write only happens
   * when EVERY lake a retrieval call resolved has opted in (unanimity), never partially. Exposed
   * to a reader (see LAKE_FIELD_VISIBILITY) so the people whose questions may be logged can see
   * that the lake records them. Flipping this off does not retro-delete already-written query
   * text - it expires on its own (shorter) retention clock.
   */
  auditQueryTextEnabled?: boolean;
  /** Whether this data lake is active or archived */
  status: DataLakeStatus;
  /** Cached file count (updated on upload/delete) */
  fileCount?: number;
  /** Cached total size in bytes (updated on upload/delete) */
  totalSizeBytes?: number;
  /**
   * Cached sum of member files' chunkedCharCount (Unicode code points of chunked text) -
   * the retrievable-content denominator for lake health (#1666). Recomputed with
   * fileCount/totalSizeBytes by recomputeLakeStats; never incremented in place.
   */
  totalChunkedChars?: number;
  /**
   * Lifetime embedding spend attributed to this lake, in integer micro-USD (1e-6 USD - a
   * single chunk can cost well under a cent). Reserved atomically BEFORE each provider
   * embedding call via tryAddEmbeddingSpend, so it can slightly overcount on a crash between
   * reserve and call, never undercount. Enforces the dataLakeEmbeddingBudgetPerLakeUsd lever.
   */
  embeddingSpendMicroUsd?: number;
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
  /**
   * The exact `archivedAt` stamp archive wrote on this lake's members, so restore (after a
   * delete of an already-archived lake) can clear that batch's archive marker and nothing
   * else's - mirrors `filesDeletedAt` but on the archive axis. Matched by EQUALITY: a
   * prefix-sharing sibling lake's own archive of that same file (a different stamp) is never
   * touched, provided the sibling archived first - `archiveByDataLakeTag` only ever stamps
   * `archivedAt: null` rows, so whichever lake archives a shared file first owns its marker.
   * Claimed set-if-unset; cleared by unarchive (so a later re-archive gets a fresh stamp, not a
   * stale reused one) and by a restore that clears it.
   *
   * The key is a wall-clock `Date`, not a unique token - equality is a best-effort ownership test,
   * not a guarantee, and two lakes claiming in the same millisecond would collide (same design as
   * `filesDeletedAt`, not new to this field). A stamp that ends up naming zero rows (an empty lake,
   * or a concurrent sibling/same-lake claim that swept the shared rows first) is kept, not cleared
   * back to null - clearing it would read downstream as "pre-field legacy" and unarchive that lake
   * unbounded, freeing whatever a sibling or a co-owning lake legitimately holds under its own
   * stamp. An orphaned stamp naming nothing is the safe value: bounding a later unarchive to it
   * also matches nothing, which is correct for a lake with nothing of its own to restore.
   *
   * Absent on a lake archived before this field existed (or one whose members already carry an
   * unstamped `archivedAt` for any other reason). `restoreDeletedDataLake` (the delete axis)
   * leaves that archive marker exactly as it is instead of guessing at a batch it cannot prove.
   * `unarchiveDataLake` cannot do the same - unarchiving IS the operation that clears `archivedAt`
   * - so an absent stamp there falls back to the pre-this-field behavior of unarchiving every
   * member in scope unbounded; a prefix- or meta-tag-sharing sibling's own archived member is only
   * safe from that fallback once both lakes carry a real stamp. `archiveDataLake` skips claiming a
   * fresh stamp in the legacy case too (see its own `hasUnstampedArchive` guard) rather than
   * recording a mark that would name none of the pre-existing archived rows.
   */
  filesArchivedAt?: Date | null;
  /**
   * Lake-memory producer (#1440) bookkeeping - server-managed, never client input.
   *
   * A concurrency LEASE, not a status: a run stamps it to claim the lake and clears it when done, so a
   * second near-simultaneous batch finalize that finds a fresh stamp skips its (LLM-billed, redundant)
   * extraction. A lease rather than a boolean so a crashed run frees itself once the stamp ages past the
   * lease window, without needing a reconciler. Absent/null = no run holds the lease.
   */
  lakeMemoryExtractionAt?: Date | null;
  /**
   * Bounded-continuation watermark for the lake-memory producer (#1440): the id of the last document an
   * interrupted run ATTEMPTED. The next run resumes from the document after it (keyset), so a lake too
   * large for one Lambda invocation is covered across chained runs instead of silently truncated.
   * Cleared once a scan reaches the end, so the following finalize does a fresh whole-lake re-scan (which
   * re-asserts existing facts and keeps them hot). Absent/null = start from the beginning.
   */
  lakeMemoryCursor?: string | null;
}

export interface IDataLakeDocument extends IDataLake, IMongoDocument {}

export interface IDataLakeRepository extends IBaseRepository<IDataLakeDocument> {
  /**
   * Resolve a lake by slug. Slug is unique only per scope (organizationId), so pass the
   * caller's membership set to disambiguate: a lake in one of the caller's own orgs is
   * preferred, falling back to an org-less lake with that slug. Without a set, only
   * org-less lakes match.
   */
  findBySlug(slug: string, organizationIds?: string[]): Promise<IDataLakeDocument | null>;
  /** Resolve a lake by its globally-unique join meta-tag (`datalake:<slug>` / `datalake:<org>:<slug>`). */
  findByDatalakeTag(datalakeTag: string): Promise<IDataLakeDocument | null>;
  findActiveByUserTags(userTags: string[]): Promise<IDataLakeDocument[]>;
  /**
   * Entitlement-aware variant of `findActiveByUserTags`: active lakes the user can reach by
   * a matching `requiredUserTag`, a matching `requiredEntitlement` (against the caller's
   * resolved entitlement keys), or - for a gateless ORG lake - membership in its org. Plus
   * the caller's OWN lakes (owner bypass). Mirrors the HTTP path's `findAccessible`.
   *
   * `organizationIds` is the hard org prerequisite: org-less lakes stay reachable cross-org
   * (curated opti/help); an org-scoped lake only resolves for a caller who is a MEMBER of that
   * org (owner + `users[]` ACL - see `IOrganizationRepository.findMembershipOrgIds`, #1674).
   * Empty/absent never widens access - it collapses every org arm to its org-less-only form.
   *
   * `userId` is the owner bypass + the Private-by-default rule: a lake with NO org and NO
   * gate is owner-only (not world-readable). Supply it on every user-facing retrieval call;
   * omit only for owner-agnostic lookups (then gateless org-less lakes match no one).
   */
  findActiveByUserTagsAndEntitlements(
    userTags: string[],
    entitlementKeys: string[],
    organizationIds?: string[] | null,
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
    opts?: { statuses?: DataLakeStatus[]; includePublic?: boolean; grantedLakeIds?: string[] }
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
  setStats(
    id: string,
    stats: { fileCount: number; totalSizeBytes: number; totalChunkedChars: number }
  ): Promise<IDataLakeDocument | null>;
  /**
   * Atomically reserve `amountMicroUsd` of embedding spend against this lake, but only if
   * the running total stays within `limitMicroUsd`. All-or-nothing; false means the caller
   * must NOT make the provider call. Call BEFORE spending, so a crash can only overcount.
   * `limitMicroUsd <= 0` always denies (0 is the operator's "stop" value).
   */
  tryAddEmbeddingSpend(id: string, amountMicroUsd: number, limitMicroUsd: number): Promise<boolean>;
  /**
   * Metered twin of tryAddEmbeddingSpend: identical atomic reserve-first contract, but returns
   * the post-increment lifetime total instead of a boolean, so a caller can compute %-of-budget
   * without a second, racy read. `spendMicroUsd` is `null` on denial and on the amount<=0
   * no-op-success branch (no document read happened) - never treat `null` as zero spend.
   */
  tryAddEmbeddingSpendMetered(
    id: string,
    amountMicroUsd: number,
    limitMicroUsd: number
  ): Promise<{ granted: boolean; spendMicroUsd: number | null }>;
  /**
   * Return a reservation that never became a provider call (the call failed). Exact-inverse of
   * ONE tryAddEmbeddingSpend grant, guarded so it cannot drive the meter negative; false means
   * the meter was already below the amount (e.g. an admin reset raced it) and nothing changed.
   */
  releaseEmbeddingSpend(id: string, amountMicroUsd: number): Promise<boolean>;
  /**
   * Admin remedy: zero this lake's lifetime spend meter. Exists because releases are best-effort
   * (a hard crash between reserve and release still leaks) and the levers are global - without a
   * per-lake reset the only way to unstick a poisoned lake is a hand-written Mongo update.
   */
  resetEmbeddingSpend(id: string): Promise<boolean>;
  /**
   * One-way draft -> active, the transition that makes a lake reachable from `findPublicLakes`
   * and the `findActive*` retrieval arms. Guarded inside the query, so a caller holding a stale
   * copy of the document cannot resurrect an archived or deleted lake. Returns whether this call
   * was the one that flipped it.
   */
  activateIfDraft(id: string): Promise<boolean>;
  /**
   * Claim `filesDeletedAt` for a phase-1 teardown: writes `at` only if the lake carries no stamp,
   * and returns the stamp now in force - the existing one when a concurrent teardown or a crashed
   * prior attempt already claimed it. Callers must sweep with the RETURNED value, not their own,
   * or they stamp rows under a mark the lake does not name. Null means no stamp is in force: the
   * lake vanished, or a restore cleared it between the claim and the fallback read - so a null
   * caller sweeps unmarked and must say so, since that lake then restores unbounded.
   */
  claimFilesDeletedAt(id: string, at: Date): Promise<Date | null>;
  /** Claim `filesArchivedAt` for an archive sweep - same set-if-unset contract as `claimFilesDeletedAt`. */
  claimFilesArchivedAt(id: string, at: Date): Promise<Date | null>;
  /**
   * Claim `deleted -> purging` at the moment a phase-2 hard delete is ACCEPTED (#1744). Returns
   * whether THIS caller won; a loser must refuse the purge and must NOT enqueue a sweep.
   *
   * The status test lives in the FILTER for the same reason as `activateIfDraft`, and here it is
   * load-bearing rather than defensive: every write in this area is read-then-write (the route
   * pre-checks a lake it fetched, `restoreDeletedDataLake` reads then writes), so a plain `$set`
   * would let a restore that read `deleted` before this claim write its terminal `active` after
   * it. The sweep would then fail its guard and be swallowed as permanently-invalid - the exact
   * abandonment #1744 exists to remove, just through a narrower window.
   */
  claimPurging(id: string): Promise<boolean>;
  /**
   * Enter `restoring` from a soft-deleted lake, claimed rather than set so it cannot overwrite a
   * `purging` accepted between the caller's status read and this write - the mirror of the race
   * `claimPurging` closes from the other side. Re-entrant from `restoring` itself, so a crashed
   * prior attempt can still be retried. Returns whether this caller may proceed.
   */
  claimRestoring(id: string): Promise<boolean>;
  /**
   * Release `purging -> deleted` after a sweep was refused by its own guards, so the lake becomes
   * visible and retryable again instead of stranded in a state no list shows (#1744). Conditional
   * on `purging` so it can never resurrect a lake that some other transition has since moved.
   *
   * ONLY safe for a sweep that failed BEFORE destroying anything. `cleanupDeletedDataLake` throws
   * `BadRequestError` exclusively from its two entry guards, which is what makes the consumer's
   * use of this correct; a partially-swept lake must stay `purging` and be recovered by DLQ replay.
   */
  releasePurgingToDeleted(id: string): Promise<boolean>;
  /**
   * Per-lake concurrency claim for the memory producer (#1440): stamp `lakeMemoryExtractionAt = at` only
   * if no run currently holds the lease - the field is unset, OR its stamp is older than `staleBefore`
   * (a crashed run's expired lease). Returns whether THIS caller won the claim. Guarded in the query, so
   * a concurrent claimer that already stamped a FRESH value makes this a no-op; exactly one run wins.
   */
  claimLakeMemoryExtraction(id: string, at: Date, staleBefore: Date): Promise<boolean>;
  /**
   * Release the extraction lease, but only if THIS run still holds it (the stamp still equals
   * `claimedAt`). The guard matters when a stale takeover occurred mid-run: a late finish must not clear
   * the lease a newer run has since claimed.
   */
  releaseLakeMemoryExtraction(id: string, claimedAt: Date): Promise<void>;
  /**
   * Persist (with a doc id) or clear (with null) the bounded-continuation cursor - the id of the last
   * document the current scan attempted. Null marks the scan complete, so the next finalize re-scans the
   * whole lake.
   */
  setLakeMemoryCursor(id: string, cursor: string | null): Promise<void>;
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
export type TaxonomyStatus =
  'none' | 'queued' | 'analyzing' | 'ready' | 'applying' | 'applied' | 'failed' | 'dismissed';

/** Non-terminal taxonomy phases - the ones the stuck-job reconciler may force to 'failed'. */
export const TAXONOMY_NON_TERMINAL_STATUSES: TaxonomyStatus[] = ['queued', 'analyzing', 'applying'];

/**
 * Every phase the Data Lakes list needs to show a badge for: still running, OR finished and
 * awaiting the user (ready to review / failed and dismissible). Excludes 'none' (never opted
 * in) and both resolved terminal outcomes, 'applied' and 'dismissed' (nothing left to surface
 * for either - a dismissed batch's suggestions are never shown again, same as an applied one).
 * Includes 'applying' so a batch stuck there (e.g. an apply request that errored or hit the
 * Lambda timeout mid-write) stays visible to the list and the fast read-time reconciler instead
 * of only being reachable by the daily cron sweep.
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
  /** Subset of failedFiles caused by chunk/vectorize (vs a browser upload failure) - see the
   * schema comment on this field for why it's tracked separately. */
  processingFailedFiles: number;
  skippedFiles: number;

  // Size tracking
  totalSizeBytes: number;
  uploadedSizeBytes: number;

  /** Embedding spend metered against this run, integer micro-USD - same reserve-first
   * contract as IDataLake.embeddingSpendMicroUsd. Enforces the per-run budget lever. */
  embeddingSpendMicroUsd?: number;

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

export type BatchCounterField =
  'uploadedFiles' | 'chunkedFiles' | 'vectorizedFiles' | 'failedFiles' | 'processingFailedFiles' | 'skippedFiles';

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
  /** Per-run twin of IDataLakeRepository.tryAddEmbeddingSpend - same reserve-first,
   * all-or-nothing contract, metered against this batch's embeddingSpendMicroUsd. */
  tryAddEmbeddingSpend(batchId: string, amountMicroUsd: number, limitMicroUsd: number): Promise<boolean>;
  /** Per-run twin of IDataLakeRepository.releaseEmbeddingSpend - same exact-inverse contract. */
  releaseEmbeddingSpend(batchId: string, amountMicroUsd: number): Promise<boolean>;
  /** Atomic multi-field variant of incrementCounter - use when two+ counters must land together
   * (e.g. failedFiles + processingFailedFiles), so a crash between them can't leave one applied
   * and the other not. */
  incrementCounters(
    batchId: string,
    fields: Partial<Record<BatchCounterField, number>>
  ): Promise<IDataLakeBatchDocument | null>;
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
   * Bump `updatedAt` on a still-non-terminal batch, without touching status or counters. Used
   * by the chunk/vectorize handlers on a non-final SQS delivery attempt, so a batch that is
   * legitimately mid-retry doesn't go idle long enough for the stuck-batch reconciler (which
   * keys off `updatedAt`) to force it terminal before the next attempt lands. Guarded the same
   * way as `setStatusIfActive`/`markTerminalIfActive`, so it can never resurrect a batch the
   * pipeline already finalized.
   */
  touchIfActive(batchId: string): Promise<void>;
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
   * Mirrors `findStuck`'s shape, served by the `{ taxonomyStatus: 1, taxonomyStartedAt: 1 }`
   * index. Filters on `taxonomyStartedAt`, not `updatedAt` - taxonomy runs decoupled from
   * ingest, so an unrelated write to the same batch (an ingest counter increment, say) keeps
   * bumping `updatedAt` while `taxonomyStartedAt` - when THIS taxonomy attempt actually began -
   * stays fixed; filtering on the wrong field could let a genuinely stuck batch dodge every scan.
   */
  findStuckTaxonomy(cutoff: Date, limit?: number): Promise<IDataLakeBatchDocument[]>;
  /**
   * Force a stuck taxonomy job to `'failed'`, guarded on BOTH `taxonomyStatus` (must still be
   * one of `from`) AND staleness (`taxonomyStartedAt` must still be before `startedBefore`) -
   * the second guard closes a race `setTaxonomyStatusIfActive` alone can't: the reconciler
   * decides "stuck" from a snapshot read at fetch time, and without re-checking staleness at
   * write time, a batch that legitimately re-claimed (the ordinary worker's own
   * `queued -> analyzing` claim, which refreshes `taxonomyStartedAt`) between the reconciler's
   * read and its write would still match a status-only guard, discarding real in-flight work.
   * Used only by `reconcileStuckTaxonomy` - every other taxonomy-status writer wants a plain
   * status guard and should keep using `setTaxonomyStatusIfActive`.
   */
  forceFailStuckTaxonomy(
    batchId: string,
    from: TaxonomyStatus[],
    startedBefore: Date,
    taxonomyError: string
  ): Promise<IDataLakeBatchDocument | null>;
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

/**
 * Wire shape of GET /api/data-lakes/:id/spend. `embeddingSpendMicroUsd` is the lake's
 * lifetime RESERVATION-TIME meter (reserve-first, admin-reset/release-compensated);
 * `ledger` is the ATTRIBUTED cost rolled up from UsageEvent rows (ingestion embeds only).
 * Neither is a provider-reported figure - both derive from the same pre-call, Math.ceil'd
 * estimate over locally-counted tokens (fabFileVectorize writes the ledger's `costUsd`
 * from `estimatedMicroUsd`, the exact value the meter reserved). They diverge only via an
 * admin reset or a release-after-failure, not because one is "actual" and the other isn't -
 * the client must label them distinctly (lifetime meter vs. attributed/ledgered cost)
 * without implying either is a true provider-billed number. Budgets mirror
 * `resolveSpendLevers()`'s live values so the view never has to re-derive them - resolved at the
 * lake's OWN cost tier, so they are the same ceilings the ingestion gate enforces on it.
 */
export interface IDataLakeSpendResponse {
  dataLakeId: string;
  /** Trailing window the ledger rollup covers. */
  days: number;
  /** Lifetime reservation-time meter (see doc comment above); null when unset (pre-existing lake). */
  embeddingSpendMicroUsd: number | null;
  spendEnabled: boolean;
  perRunBudgetMicroUsd: number;
  perLakeBudgetMicroUsd: number;
  perPeriodBudgetMicroUsd: number;
  periodHours: number;
  /**
   * Cost-tier factor the two per-resource budgets above were scaled by, from the lake's ownership
   * (individual vs organization). Returned so the view can explain a ceiling rather than just state it.
   */
  tierMultiplier: number;
  /** Actual COGS from the UsageEvent ledger (ingestion embeds attributed to this lake). */
  ledger: ILakeUsageSummary;
}

/**
 * Overlay store for a STATIC (registry) data lake's admin-settable session defaults. A fallback
 * lake has no backing document (see `isFallbackLake`), so it has nowhere to persist an override -
 * this collection is that home, keyed by the registry lake's `id` rather than a Mongo `_id`
 * relationship. Deliberately NOT a `ScopedSetting` row: these are lake CONTENT (the same fields a
 * DB lake stores directly on its document), not a resolved operational lever, and every consumer
 * reads them off a lake object rather than through the scoped-settings resolver.
 *
 * `groundingMode` (Phase 0), `preferredSystemPromptId` (Phase 1) and `systemPrompt` (Phase 2) all
 * live here. `systemPrompt` is injected free text, so it is gated on a NARROWER trust rule than
 * the other two: `isTrustedForInjection` (getDataLakePrompts.ts) treats a registry lake as trusted
 * ONLY when it is org-scoped and the caller is a member of that org - the same rule an ordinary
 * DB lake's org arm already applies, never wider. A gateless/global registry lake's systemPrompt
 * is stored here but never injected (deliberately - see that rule's doc comment for why unbounded
 * cross-tenant injection was rejected as an option). `preferredSystemPromptId` carries no such
 * risk: it is an id reference re-validated against the session-activatable allowlist at every
 * write AND read boundary (see `isSessionActivatablePromptId`), never injected text itself.
 */
export interface IFallbackLakeSetting extends IMongoDocument {
  /** The registry lake's `id` (a human slug, never an ObjectId hex string - see `isFallbackLake`). */
  lakeId: string;
  /** Absent means "use the coded default" - mirrors how a DB lake treats an unset groundingMode. */
  groundingMode?: DataLakeGroundingMode;
  /**
   * Preferred registry system-prompt id (see IDataLake.preferredSystemPromptId). Absent (never an
   * empty-string stand-in) means "no preferred prompt" - the write route's `''` clear sentinel is
   * translated to absent before it reaches this row, matching how a DB lake treats the same clear.
   */
  preferredSystemPromptId?: string;
  /**
   * Per-lake system prompt (see IDataLake.systemPrompt). Stored for EVERY registry lake regardless
   * of scope - `isTrustedForInjection` is what decides whether it is ever actually injected, not
   * this storage layer, so an admin can set it ahead of a lake being re-scoped to an org without
   * losing the value. Absent (never an empty-string stand-in) means unset, matching the DB-lake
   * convention that a blank/whitespace-only prompt reads as absent.
   */
  systemPrompt?: string;
}

export interface IFallbackLakeSettingsRepository extends IBaseRepository<IFallbackLakeSetting> {
  findByLakeId: (lakeId: string) => Promise<IFallbackLakeSetting | null>;
  /** Batch read for the manager list, which renders every accessible fallback lake in one response. */
  findByLakeIds: (lakeIds: string[]) => Promise<IFallbackLakeSetting[]>;
  /**
   * Upsert-by-lakeId: a fallback lake has no document to attach this row to via the base `create`.
   * Only the keys actually present in `fields` are written - an omitted field leaves its stored
   * value alone (mirrors `updateDataLake`'s "omitted -> unchanged" semantics), so a caller that
   * sets only `groundingMode` cannot accidentally clear a previously-set `preferredSystemPromptId`.
   */
  setFields: (
    lakeId: string,
    fields: Partial<Pick<IFallbackLakeSetting, 'groundingMode' | 'preferredSystemPromptId' | 'systemPrompt'>>
  ) => Promise<IFallbackLakeSetting>;
}
