import type { InconsistencyEvidence, InconsistencyKind } from '../../constants/corpusInconsistency';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// -- Data Lake Finding -------------------------------------------------------------------------
//
// Durable identity for a machine-detected corpus problem (#3039). Detection used to produce a
// report that was written onto the lake document wholesale, so every run destroyed the last one and
// no finding could be triaged, assigned or resolved - it had no id to hold on to. A finding is a
// row here instead, keyed so re-detecting a known problem updates it rather than duplicating it.
//
// DETECT, DO NOT REJECT (carried from #2242, and it governs this whole model). A finding never
// gates ingest, never removes content and never edits a document. It means "worth a human's eye",
// never "proven wrong". Nothing may read `status` as permission to mutate a corpus.
//
// Types live here rather than beside the model because the services that read them live in
// b4m-core/services, which cannot import @bike4mind/database - the same split
// DataLakeProposalTypes, DataLakeAccessGrantModel and DataLakeSpendNotificationModel use.

/**
 * A finding is `open` until a human rules on it, and then terminal - the same shape #1671 settled
 * on for proposals (`pending` -> `approved` | `declined`), deliberately reused rather than a second
 * lifecycle invented for the same job.
 *
 * `resolved` means the underlying corpus problem was dealt with; `dismissed` means a human judged
 * there was no problem to deal with. Both are a human's word about the corpus, never an instruction
 * to the system: neither status causes anything to be ingested, re-chunked or removed.
 */
export const LAKE_FINDING_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type LakeFindingStatus = (typeof LAKE_FINDING_STATUSES)[number];

/** The terminal statuses a curator may move an open finding to. */
export type LakeFindingTerminalStatus = Exclude<LakeFindingStatus, 'open'>;

/**
 * Which pass produced the finding. `lexical` is the pure pattern engine that ships today
 * (`corpusInconsistency.ts`, LLM-free by design); `model` is the reading pass (#3057).
 *
 * A closed union rather than the free-form string `DataLakeProposalProvenance.producer` uses, and
 * the difference is deliberate: `detector` is part of this collection's unique KEY, so a typo in a
 * free-form value would not fail - it would quietly mint a second row for a problem that already
 * has one, which is the exact duplication the key exists to prevent.
 */
export const LAKE_FINDING_DETECTORS = ['lexical', 'model'] as const;
export type LakeFindingDetector = (typeof LAKE_FINDING_DETECTORS)[number];

/**
 * How many sources one finding may carry. Deliberately its own constant rather than an alias of the
 * detector's `EVIDENCE_MAX`: that one bounds a report stored on the lake document, this one bounds a
 * persisted row, and `recordLakeFindings` is the write door for producers (#3057) that build no
 * report at all. They must not DRIFT, though, so a test pins them equal - a comment could not.
 */
export const LAKE_FINDING_SOURCE_MAX = 20;

/** Longest resolution note a curator may leave. Mirrors the proposal decline-reason cap. */
export const LAKE_FINDING_RESOLUTION_MAX_CHARS = 500;

/**
 * One document implicated in a finding, with the passage that implicated it.
 *
 * Structurally the detector's `InconsistencyEvidence` today, but declared here rather than aliased
 * to it because this one is PERSISTED: a field added to the detector's in-memory evidence type
 * would be silently stripped by Mongoose strict mode on write, and nothing would go red. Spelling
 * it out keeps the parity a two-file question (this type and `DataLakeFindingSchema`) instead of a
 * three-file one. `StorableEvidence` below fails the build if the shapes ever diverge.
 */
export interface LakeFindingSource {
  fabFileId: string;
  /** Null when the file was deleted between detection and the read that rendered it. */
  fileName: string | null;
  /** A trimmed sentence from the document, not the document. Bounded by the detector (240 chars). */
  excerpt: string;
}

/**
 * Compile-time guard that the detector's evidence still fits what this collection stores. If
 * `InconsistencyEvidence` gains a field, this keeps passing (the extra field is simply not
 * persisted, which is a decision to make deliberately); if it RENAMES or retypes one, this fails
 * here rather than at runtime as a silently empty column.
 *
 * A TYPE, not a function. The identity function this replaced was a working guard - TS checks a
 * declared return type at the DECLARATION, so it fired with or without a call site - but its
 * runtime export was dead weight: a function shipped to every consumer purely to make a
 * compile-time assertion that a type alias makes for free.
 */
type AssertAssignable<Target, Source extends Target> = Source;
export type StorableEvidence = AssertAssignable<LakeFindingSource, InconsistencyEvidence>;

export interface IDataLakeFinding {
  lakeId: string;
  /** The rule or reading pass that fired. Shared vocabulary with the detector, not a second one. */
  kind: InconsistencyKind;
  /**
   * The normalized thing the finding is about (`normalizeSubject`: lowercased, punctuation
   * stripped, whitespace collapsed). Part of the key, and safe to be one - the detector documents
   * it as "normalized for grouping, so it is a key rather than prose".
   */
  subject: string;
  detector: LakeFindingDetector;
  /** The documents involved, capped at LAKE_FINDING_SOURCE_MAX. Refreshed on every re-detection. */
  sources: LakeFindingSource[];
  /** How many documents the problem actually reaches, counted before `sources` was capped. */
  documentCount: number;
  status: LakeFindingStatus;
  /** When this problem was first detected. Never moves once set, including across a resolution. */
  firstSeenAt: Date;
  /**
   * The newest detection run that still saw the problem, whatever the status. ADVANCES only: the
   * write is a `$max`, so a run landing out of order (a retried queue message, a slow run finishing
   * after a later one) cannot drag it backwards. That monotonicity is what `lastSeenAt > resolvedAt`
   * rests on as the recurrence signal - it is how a surface spots a resolved problem that came back,
   * rather than the recurrence being hidden or duplicated into a second row.
   */
  lastSeenAt: Date;
  /** The curator who owns triaging this. Independent of status: an open finding may be assigned. */
  assigneeUserId?: string | null;
  /** The curator's note on what they did or why there was nothing to do. */
  resolution?: string | null;
  resolvedByUserId?: string | null;
  resolvedAt?: Date | null;
}

export type IDataLakeFindingDocument = IDataLakeFinding & IMongoDocument;

/**
 * What a detection run reports for one problem. The server owns status, both timestamps and every
 * curator field; a detector supplies only what it observed.
 */
export interface RecordLakeFindingInput {
  lakeId: string;
  kind: InconsistencyKind;
  subject: string;
  detector: LakeFindingDetector;
  sources: LakeFindingSource[];
  documentCount: number;
  /** The run's own clock, passed in so one run stamps all of its findings identically. */
  seenAt: Date;
}

/** The compare-and-set a resolution performs. `open -> resolved | dismissed`, once. */
export interface ResolveLakeFindingInput {
  status: LakeFindingTerminalStatus;
  resolvedByUserId: string;
  resolvedAt: Date;
  resolution?: string;
}

/**
 * The detector-scoped identity of a finding, without the lake. What a re-detection needs in order to
 * recognise a problem a curator has already ruled on.
 */
export interface LakeFindingKey {
  kind: InconsistencyKind;
  subject: string;
}

/** How a surface narrows one lake's findings. Every filter is optional and independent. */
export interface ListLakeFindingsOptions {
  status?: LakeFindingStatus;
  kind?: InconsistencyKind;
  detector?: LakeFindingDetector;
  /**
   * Keep only rows a run at or after this instant still saw (`lastSeenAt >= seenSince`).
   *
   * Exists because nothing ever closes a finding the detector stops reporting - and nothing should:
   * `status` is a human's word about the corpus, so a detector retiring a row would be exactly the
   * overwrite `recordDetected` refuses to do. The row therefore stays `open` forever once the
   * problem is fixed, which is right for a triage queue and wrong for "what is wrong with my corpus
   * NOW". Passing the last run's `inconsistencyComputedAt` answers the second question without
   * mutating anything, and leaves the retired row fully visible - status intact - on GET /findings.
   */
  seenSince?: Date;
  limit?: number;
}

export interface IDataLakeFindingRepository extends IBaseRepository<IDataLakeFindingDocument> {
  /**
   * Record a detected problem, creating the row on first sight and updating it on every sighting
   * after that. ATOMIC, and a single round trip: the key `(lakeId, detector, kind, subject)` is a
   * unique index and this is one upsert against it, so two runs over the same lake cannot both pass
   * a "does it exist yet" read and leave a curator the same problem twice.
   *
   * An update refreshes only what the detector observed - sources, reach, `lastSeenAt`. It never
   * touches status, assignee or resolution: a curator's decision is not a detector's to overwrite,
   * and a resolved problem that recurs must stay resolved-and-recurring rather than silently
   * reopening under the curator who closed it.
   */
  recordDetected(input: RecordLakeFindingInput): Promise<IDataLakeFindingDocument>;
  /** One lake's findings, most recently seen first, narrowed by any combination of filters. */
  listByLake(lakeId: string, options?: ListLakeFindingsOptions): Promise<IDataLakeFindingDocument[]>;
  /**
   * The keys one detector's DISMISSED findings occupy in this lake, so a re-detection can drop what
   * a curator has already judged to be no problem instead of reporting it at them again (#3045).
   *
   * Keys only, and unbounded on purpose. It is read on every detection run to filter that run's
   * output, so it must cover every dismissal rather than a page of them - which is affordable
   * precisely because it projects away `sources`, the one field on this row that has any size.
   *
   * `resolved` is deliberately NOT included. Resolved means the corpus problem was dealt with, so
   * re-detecting it means it came back and a curator has to see that; dismissed means there was
   * never a problem to deal with, and re-detection has learned nothing new.
   */
  listDismissedKeys(lakeId: string, detector: LakeFindingDetector): Promise<LakeFindingKey[]>;
  /**
   * Atomically move an OPEN finding to a terminal status, stamping the resolver. Returns the
   * updated row, or null when the filter missed - which is the whole double-resolve guard for two
   * curators racing the same finding, or one double-click. Never a read-then-write.
   *
   * `lakeId` is a FILTER term, not a convenience argument. Without it the mutation is keyed on
   * `_id` alone and belongs-to-lake becomes a rule that lives only in the route, so any future
   * caller reaching this repo directly can rule on a finding in a lake it was never authorized
   * for. Lake-first, matching `deleteForLake`. Null therefore means "not open OR not this lake's";
   * a caller that has to tell those apart re-reads (see the route's 404-vs-400 split).
   */
  resolveFinding(lakeId: string, id: string, input: ResolveLakeFindingInput): Promise<IDataLakeFindingDocument | null>;
  /**
   * Set or clear the assignee. Permitted in any status: assigning a resolved finding is how a
   * recurrence gets an owner, and forbidding it would only push that into a reopen this model
   * deliberately does not have. Lake-scoped for the same reason as `resolveFinding`.
   */
  assignFinding(lakeId: string, id: string, assigneeUserId: string | null): Promise<IDataLakeFindingDocument | null>;
  /**
   * Drop a deleted lake's findings. A finding outliving its lake is unresolvable by anyone.
   *
   * NOT sufficient on its own for a lake teardown. The teardown hard-deletes its member FabFiles
   * GLOBALLY, and a file can belong to two lakes at once, so a sibling lake's rows can be left
   * quoting a destroyed document - rows this call cannot reach, because they are not this lake's.
   * `cleanupDeletedDataLake` therefore runs `deleteForPurgedDocuments` over its destroyed ids too.
   */
  deleteForLake(lakeId: string): Promise<number>;
  /**
   * Drop every finding that cites a permanently-deleted document. A RETENTION obligation, not a
   * tidiness one: a finding stores a 240-char excerpt of each source, so a row left behind would
   * keep quoting a document the owner paid the purge door to destroy - and nothing else would ever
   * sweep it, because a finding whose document is gone can never be re-detected.
   *
   * Deletes the whole row rather than pulling the one source: what remains would be a
   * cross-document inconsistency with one side missing, which is not a finding. Re-detection
   * re-creates any disagreement that still holds among the surviving documents, with fresh sources.
   *
   * NOT lake-scoped, and that is the point. `purgeDataLakeDocument` destroys the document globally
   * - it leaves the owner's Files list and every OTHER lake it belonged to, the lake it was purged
   * through being the authorization scope rather than the blast radius. A lake-scoped sweep would
   * strand a quote of the destroyed document in every sibling lake that also held it. Same
   * reasoning as `shredDocumentMemory`, which shreds across every member lake for this reason.
   */
  deleteForPurgedDocument(fabFileId: string): Promise<number>;
  /**
   * The same retention sweep over many destroyed documents at once - everything on
   * `deleteForPurgedDocument` applies, including the deliberate lack of lake scoping.
   *
   * Exists for `cleanupDeletedDataLake`, which destroys a whole lake's documents inside a fan-out
   * already chunked for the Lambda budget: the single-id form costs one round trip per file there,
   * where an `$in` costs one per chunk against the same index. Equally replay-safe, because a
   * finding sweep is idempotent and independent of whether the FabFile row still exists - and
   * slightly MORE atomic, since a failed batch leaves its whole chunk's rows intact rather than
   * half of them destroyed.
   *
   * A no-op on an empty list. The purge door keeps the single-id form: it destroys one document
   * inside the owner's request, where a batch would buy nothing.
   */
  deleteForPurgedDocuments(fabFileIds: string[]): Promise<number>;
}
