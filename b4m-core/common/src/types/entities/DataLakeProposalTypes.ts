import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Data Lake Proposal ------------------------------------------------------------------------
//
// The acquisition proposal queue (#1671). Nothing a producer finds is ever written into a lake
// directly: it lands here in a pending state for a human to approve or decline, and only an
// approval admits it - through the ordinary ingestion door, never a side door. That separation is
// the whole design. Producers vary (a research run today, whatever comes next tomorrow); the queue
// does not, which is why these types live in common rather than beside any one producer.
//
// Types live here rather than inline in the model because the services that read them
// (proposeDataLakeContent / reviewDataLakeProposal) live in b4m-core/services, which cannot import
// @bike4mind/database - the same split DataLakeAccessGrantModel and DataLakeSpendNotificationModel use.

/**
 * A proposal is pending until a human rules on it, and then terminal. There is deliberately no
 * `auto_approved` (#1658 decision 10): a confidence score on generated content is a number with no
 * validated meaning, so shipping it as a safety control would be worse than shipping none.
 *
 * A `declined` row is also the TOMBSTONE for its source - see `IDataLakeProposal.excerpt` for what
 * a decline strips and why the row itself is kept.
 */
export const DATA_LAKE_PROPOSAL_STATUSES = ['pending', 'approved', 'declined'] as const;
export type DataLakeProposalStatus = (typeof DATA_LAKE_PROPOSAL_STATUSES)[number];

/** Longest excerpt a producer may attach. Enough to judge a source by, far short of storing it. */
export const DATA_LAKE_PROPOSAL_EXCERPT_MAX_CHARS = 4000;

/** How many tags a producer may propose for one candidate. */
export const DATA_LAKE_PROPOSAL_MAX_TAGS = 20;

/** Where a proposal came from and when - carried onto the file an approval admits. */
export interface DataLakeProposalProvenance {
  /** The producer kind, e.g. `research_run`. Free-form so a new producer needs no schema change. */
  producer: string;
  /** The producing run, when the producer has one. The join key back to why this was proposed. */
  runId?: string;
  /** The question the run was answering, when it had one. Shown to the reviewer as context. */
  query?: string;
  /** When the producer actually retrieved the candidate - not when the row was written. */
  retrievedAt: Date;
}

export interface IDataLakeProposal {
  dataLakeId: string;
  status: DataLakeProposalStatus;
  /**
   * The link a reviewer opens: the producer's URL with any embedded credentials stripped
   * (`sanitizeSourceUrlForRecord`), tracking parameters and fragment INTACT. Not the dedup key -
   * see `canonicalSourceKey` for why the two are different values.
   */
  sourceUrl: string;
  /**
   * The dedup identity of the source (`canonicalSourceKey`). Every dedup decision - duplicate,
   * already admitted, tombstoned - is keyed on this, never on `FabFile.contentHash` (client-side
   * byte hash, unverified, absent on files no upload door created) and never on the vector index
   * (torn down per member by convergence, so an overlapping run would re-propose what the lake
   * already holds).
   */
  canonicalSourceKey: string;
  /** The candidate's title, as the producer read it from the source. */
  title: string;
  /**
   * A bounded sample of the candidate text, for the reviewer to judge by. NOT the document - the
   * full content is fetched from `sourceUrl` at approval time, through the ordinary ingestion door.
   *
   * Cleared on decline: a declined proposal is kept as a tombstone (source identity, reason, who,
   * when) but "the declined material itself is not retained". `textHash` survives a decline because
   * a hash is not the material, and detecting that a tombstoned source has changed materially is
   * exactly what it is for.
   */
  excerpt?: string | null;
  /**
   * `computeServerTextHash` over the candidate text the producer retrieved - the SECONDARY dedup
   * signal, comparable with `FabFile.serverTextHash` because both sides normalize identically
   * (NFC, whitespace runs folded, trimmed). Whitespace-insensitive and policy-independent by
   * construction, so it means "materially the same text", not "the same bytes".
   *
   * Optional: a producer that cannot hash its candidate gets source-keyed dedup only. Absent on
   * both sides is never read as "the same" - see `proposeDataLakeContent`.
   */
  textHash?: string | null;
  /** Tags the producer suggests for the admitted file. Advisory - the reviewer's lake decides. */
  proposedTags: string[];
  /**
   * The producer's own 0..1 confidence in the candidate. ADVISORY DISPLAY ONLY. Nothing in this
   * system may gate, sort-out or auto-approve on it; there is no threshold lever, by design.
   */
  confidence?: number | null;
  provenance: DataLakeProposalProvenance;
  /**
   * Set when this source has been ruled on before and came back with materially different text.
   * Surfaced to the reviewer so a previously-declined source is re-proposed VISIBLY rather than
   * suppressed silently - the tombstone informs the human, it does not decide for them.
   */
  priorDisposition?: DataLakeProposalStatus | null;
  reviewedByUserId?: string | null;
  reviewedAt?: Date | null;
  /** The reviewer's reason for declining. Part of the tombstone. */
  declineReason?: string | null;
  /** The file an approval admitted. Absent while pending, and on every declined row. */
  admittedFabFileId?: string | null;
}

export type IDataLakeProposalDocument = IDataLakeProposal & IMongoDocument;

/** What a producer supplies. The server derives status, canonical key and every review field. */
export interface CreateDataLakeProposalInput {
  dataLakeId: string;
  sourceUrl: string;
  canonicalSourceKey: string;
  title: string;
  excerpt?: string;
  textHash?: string;
  proposedTags: string[];
  confidence?: number;
  provenance: DataLakeProposalProvenance;
  priorDisposition?: DataLakeProposalStatus;
}

/**
 * What `createProposal` reports. `created: false` is the LOST side of a create race: a concurrent
 * producer run's pending row for the same source landed first, so this candidate is the duplicate
 * open question the caller already has an outcome for. Not an error - the caller reports it as
 * `duplicate_pending`, exactly as it would have had its preceding dedup read seen the winner.
 */
export type CreateDataLakeProposalResult =
  { created: true; proposal: IDataLakeProposalDocument } | { created: false; pendingProposalId: string };

/** The compare-and-set a review performs. `pending -> approved | declined`, once. */
export interface ReviewDataLakeProposalInput {
  status: Extract<DataLakeProposalStatus, 'approved' | 'declined'>;
  reviewedByUserId: string;
  reviewedAt: Date;
  declineReason?: string;
}

export interface IDataLakeProposalRepository extends IBaseRepository<IDataLakeProposalDocument> {
  /**
   * Insert a candidate, always as `pending` - the status is the server's to set, never a caller's.
   * ATOMIC in the one way that matters: at most one pending row per source per lake, enforced by a
   * unique index rather than by the caller's preceding dedup read, so two overlapping producer runs
   * cannot both enter the queue and leave a reviewer two cards that admit one source twice.
   */
  createProposal(input: CreateDataLakeProposalInput): Promise<CreateDataLakeProposalResult>;
  /**
   * The most recent proposal for a source in a lake, whatever its status - the single read every
   * dedup decision is made from. One query rather than three status-specific ones: the LATEST row
   * is the lake's current disposition toward that source (a source declined, re-proposed and
   * approved is approved), so an older row can never be the right answer.
   */
  findLatestBySourceKey(dataLakeId: string, canonicalSourceKey: string): Promise<IDataLakeProposalDocument | null>;
  /** The review queue for a lake, newest first, optionally narrowed to one status. */
  listByLake(
    dataLakeId: string,
    options?: { status?: DataLakeProposalStatus; limit?: number }
  ): Promise<IDataLakeProposalDocument[]>;
  /**
   * Atomically move a PENDING proposal to a terminal status, stamping the reviewer. Returns the
   * updated row, or null when it was not pending - which is the entire double-review guard: two
   * reviewers racing the same proposal, or one double-click, admits content once and only once.
   * Never a read-then-write.
   */
  claimForReview(id: string, input: ReviewDataLakeProposalInput): Promise<IDataLakeProposalDocument | null>;
  /** Record the file an approval admitted, once the ingestion door has created it. */
  recordAdmission(id: string, fabFileId: string): Promise<void>;
  /**
   * Return a claimed proposal to the queue, used only when admission FAILED after the claim. Clears
   * the reviewer stamp so the row reads as untouched rather than as approved-but-empty.
   */
  releaseClaim(id: string): Promise<void>;
  /** Drop a deleted lake's queue. A proposal outliving its lake is unreviewable by anyone. */
  deleteForLake(dataLakeId: string): Promise<number>;
}
