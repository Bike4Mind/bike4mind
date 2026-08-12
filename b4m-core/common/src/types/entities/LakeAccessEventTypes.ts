import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Lake Access Event ----------------------------------------------------------------------
//
// The audit trail a lake never had: one row per retrieval call, answering "who read this lake,
// and when" (see #1658's "zero lake access records of any kind" finding). Types live here rather
// than inline in the model (unlike MemoryLedgerEventModel) because the callers that will record
// events (#1678's retrieval surfaces) live in b4m-core/services, which cannot import
// @bike4mind/database - the same split DataLakeAccessGrantModel uses.
//
// SCOPE: this module is the event shape and vocabulary only. Nothing here calls `record()` yet -
// instrumenting the retrieval surfaces is a separate ticket.

/** Who performed the retrieval. Flat fields (not a nested object), mirroring
 * MemoryLedgerEventModel's principalKind/principalId shape. */
export const LAKE_ACCESS_PRINCIPAL_KINDS = ['user', 'agent', 'apiKey', 'system'] as const;
export type LakeAccessPrincipalKind = (typeof LAKE_ACCESS_PRINCIPAL_KINDS)[number];

/**
 * Which code path produced the retrieval. `rlm-answer` is reserved for the RLM answer endpoint's
 * own in-process retrieval - its loopback tool call to the semantic-search route must be recorded
 * under `data-lake-semantic-search` instead (whichever surface #1678 instruments), or one
 * user-visible retrieval double-counts as two events.
 */
export const LAKE_ACCESS_SURFACES = [
  'data-lake-semantic-search',
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

export interface ILakeAccessEvent {
  principalKind: LakeAccessPrincipalKind;
  principalId: string;
  /** Set when a system/agent principal acted for a human, so the human is still findable in "who
   * read this" without conflating the two identities in `principalId`. */
  onBehalfOfUserId?: string;
  organizationId?: string;
  /**
   * The retrieval SCOPE that was authorized and searched, not per-chunk attribution - the
   * retrieval primitives this event records do not carry which lake produced which chunk. One
   * retrieval call commonly spans several lakes at once. Answers "was lake X in scope for this
   * read", not "did this specific chunk come from lake X".
   */
  resolvedLakeIds: string[];
  /** Identifiers only - chunk TEXT must never reach this model. */
  returnedChunkIds: string[];
  /** Some surfaces (whole-document retrieval) are file-granular and never see a chunk id. */
  returnedFileIds: string[];
  /** Pre-truncation count, so volume stays measurable even when identifiersTruncated is true. */
  returnedChunkCount: number;
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
  /** Test-only injectable clock. */
  now?: Date;
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
