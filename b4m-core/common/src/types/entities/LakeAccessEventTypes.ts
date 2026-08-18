import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Lake Access Event ----------------------------------------------------------------------
//
// The audit trail a lake never had: one row per retrieval call, answering "who read this lake,
// and when". Types live here rather than inline in the model (unlike MemoryLedgerEventModel)
// because the callers that record events live in b4m-core/services, which cannot import
// @bike4mind/database - the same split DataLakeAccessGrantModel uses.
//
// SCOPE: this module is the event shape and vocabulary. The write path lives on
// LakeAccessEventModel.record(); the retrieval surfaces call it via recordLakeAccessEvent.
//
// PRODUCT DECISION: a query that returns zero lake content is not recorded at all, even though
// the query itself happened - every retrieval surface skips the write on an empty/unattributable
// result (see each call site's own guard). This trail answers "what was read", not "what was
// asked" - a principal probing a lake's contents with queries that happen to match nothing leaves
// no row here. Revisit if that gap ever needs closing; it is deliberate, not an oversight.

/** Who performed the retrieval. Flat fields (not a nested object), mirroring
 * MemoryLedgerEventModel's principalKind/principalId shape. */
export const LAKE_ACCESS_PRINCIPAL_KINDS = ['user', 'agent', 'apiKey', 'system'] as const;
export type LakeAccessPrincipalKind = (typeof LAKE_ACCESS_PRINCIPAL_KINDS)[number];

/**
 * Which code path produced the retrieval. `rlm-answer` is reserved for the RLM answer endpoint's
 * own in-process retrieval - its loopback tool call to the semantic-search route is recorded
 * under `data-lake-semantic-search` instead, or one user-visible retrieval double-counts as two
 * events.
 */
export const LAKE_ACCESS_SURFACES = [
  'data-lake-semantic-search',
  'data-lake-articles',
  'data-lake-public-browse',
  'data-lake-sync-delta',
  // The GET /api/files/:id lake-accessible fallback (files/[id]/index.ts) - same single-file
  // metadata + URL read as the articles `?id=` deep link, reached through a different door, so it
  // gets its own value rather than reusing data-lake-articles and conflating the two entry points.
  'data-lake-file-fallback',
  'chat-kb-search',
  'chat-kb-search-scoped',
  'chat-kb-retrieve',
  'forced-retrieval',
  'rlm-answer',
] as const;
export type LakeAccessSurface = (typeof LAKE_ACCESS_SURFACES)[number];

/** Cap on persisted identifiers per event; a retrieval returning more is reported truncated
 * rather than growing the document unbounded. Realistic volumes are far below this (semantic
 * search caps top_k at 100; forced retrieval is char-budgeted), so this is headroom, not a limit
 * anyone is expected to hit. */
export const LAKE_ACCESS_EVENT_MAX_IDS = 500;

/** Per-element cap on a chunk/file identifier, enforced at the schema layer - not just by field
 * naming - so a future caller that mistakenly hands this model a passage/snippet instead of an
 * id cannot silently turn the audit trail into a copy of the corpus. Real ids are short; this is
 * generous headroom, not a realistic limit. */
export const LAKE_ACCESS_IDENTIFIER_MAX_CHARS = 256;

export interface ILakeAccessEvent {
  principalKind: LakeAccessPrincipalKind;
  principalId: string;
  /** Set when a system/agent principal acted for a human, so the human is still findable in "who
   * read this" without conflating the two identities in `principalId`. */
  onBehalfOfUserId?: string;
  /**
   * The READER's organization - whoever performed the retrieval, not necessarily the lake
   * owner's. A caller answering "who read *my org's* lake" (the question an org-manageable-lake
   * admin actually asks) must filter/join on the lake's own org, not this field; an outside
   * grant-holder's read is a real row here under their own org, and `listByLake` returns nothing
   * for that admin if they filter on this field instead.
   */
  organizationId?: string;
  /**
   * Best-effort attribution: lakes whose `datalake:<slug>` meta-tag appears on a returned
   * result, OR (for a static-registry lake only) whose open content-tag prefix appears - a
   * registry lake's files structurally cannot carry its meta-tag (no write path stamps one for a
   * fallback lake), so without this second arm every retrieval of registry content would be
   * unattributable, which is the NORMAL shape of a read there, not an edge case. Narrowed from the
   * full authorized scope where either is recoverable. One retrieval call commonly spans several
   * lakes.
   *
   * When nothing in the result set carries a recoverable tag, `attributeAccessedLakeIds`'s
   * `allowFullScopeFallback` option decides what happens: `true` (the default) falls back to the
   * FULL authorized/searched scope, so a lake is never dropped from its own audit trail just
   * because attribution was inconclusive - sound ONLY where every possible result is guaranteed
   * lake content. Every other retrieval surface searches a corpus mixed with owned/shared
   * content, where an inconclusive match may be the caller's own private file; those pass `false`
   * and skip the row entirely rather than fabricate a lake read that never happened. As of this
   * writing every non-scoped call site is mixed-corpus and passes `false` - the `true` default
   * exists for a genuinely lake-only search, not because one is wired to it today. A single
   * already-authorized file (the `?id=` deep link, the `/api/files/:id` lake fallback) does not
   * go through this fallback at all; it is attributed via `grantingLakes`, which names the
   * specific granting lake(s) directly rather than falling back to the full scope.
   */
  resolvedLakeIds: string[];
  /** Identifiers only - chunk TEXT must never reach this model. */
  returnedChunkIds: string[];
  /** Some surfaces (whole-document retrieval) are file-granular and never see a chunk id. */
  returnedFileIds: string[];
  /** Pre-truncation counts, so volume stays measurable even when identifiersTruncated is true -
   * tracked separately because a file-granular surface (see returnedFileIds) contributes only to
   * the file count, and a chunk-granular one only to the chunk count. */
  returnedChunkCount: number;
  returnedFileCount: number;
  identifiersTruncated: boolean;
  surface: LakeAccessSurface;
  /** Whether a query-text sibling document was written for this event (see
   * LakeAccessQueryTextModel). Reflects the OUTCOME of the write attempt, not just the opt-in
   * decision - a swallowed failure on the best-effort text write must not leave this true with no
   * text to show for it. */
  queryTextLogged: boolean;
  /** Computed at write time from the floor-clamped retention; TTL-indexed. */
  expiresAt: Date;
}

export interface ILakeAccessEventDocument extends ILakeAccessEvent, IMongoDocument {}

export interface RecordLakeAccessEventInput {
  principalKind: LakeAccessPrincipalKind;
  principalId: string;
  onBehalfOfUserId?: string;
  organizationId?: string;
  resolvedLakeIds: string[];
  chunkIds?: string[];
  fileIds?: string[];
  surface: LakeAccessSurface;
  /** Dropped before it can reach Mongo unless every resolved lake has opted in - see
   * LakeAccessQueryTextModel and the unanimity rule in `record()`. */
  queryText?: string;
  /** The platform-configured retention (days), if resolved by the caller; unconditionally
   * clamped to the floor inside `record()` regardless of what is passed here. */
  retentionDays?: number;
  queryTextRetentionDays?: number;
}

export interface ILakeAccessEventRepository extends Pick<
  IBaseRepository<ILakeAccessEventDocument>,
  'find' | 'findOne' | 'findById' | 'count'
> {
  record(input: RecordLakeAccessEventInput): Promise<ILakeAccessEventDocument>;
  listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeAccessEventDocument[]>;
  listByPrincipal(
    principalKind: LakeAccessPrincipalKind,
    principalId: string,
    opts?: { limit?: number }
  ): Promise<ILakeAccessEventDocument[]>;
}

// -- Lake Access Query Text -----------------------------------------------------------------
//
// The most useful field for a customer and the most sensitive - stored ONLY when every lake in
// an event's resolvedLakeIds has opted in (auditQueryTextEnabled on DataLakeModel), and with a
// SHORTER retention than the event itself. Kept in a separate collection because a Mongo TTL
// index deletes the whole document it is declared on; two different lifetimes cannot live on one
// document, so the shorter-lived field cannot simply sit alongside the event.

export interface ILakeAccessQueryText {
  /** Truncated to LAKE_ACCESS_QUERY_TEXT_MAX_CHARS; see queryTextTruncated. */
  queryText: string;
  queryTextTruncated: boolean;
  /** Always earlier than the owning event's expiresAt. */
  expiresAt: Date;
}

/** The query-text document's `_id` IS the owning event's `_id` - a 1:1 join with no extra index,
 * and "more than one query text per event" is simply unrepresentable. */
export interface ILakeAccessQueryTextDocument extends ILakeAccessQueryText, IMongoDocument {}
