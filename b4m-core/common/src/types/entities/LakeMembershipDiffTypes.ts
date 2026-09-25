import type { LakeMembershipChangeOrigin, LakeMembershipChangePrincipalKind } from './LakeMembershipChangeEventTypes';

// -- Lake Membership Diff View ---------------------------------------------------------------
//
// The read shape over LakeMembershipChangeEventModel: what joined and left one lake between two
// instants, and who drove each move. Sibling of LakeConfigHistoryView, which answers the same
// question for a lake's CONFIG - the two render under the same manage gate.
//
// The asymmetry this file exists to make explicit: `added` and `removed` come out of the event
// log alone, while `unchanged` does not. A file that never moved leaves no row, so naming it
// requires today's membership rewound to the window - and that rewind is only sound while the log
// covers the whole span. Hence `unchangedCount` is optional and `unchangedUnknownReason` says why
// it is missing, rather than a confident number derived from a log that was not yet collecting.

/**
 * One file's NET move across the window, attributed to the event that produced the state it ends
 * in. Net, not per-event: a file that left and rejoined inside the window is one row, not two, and
 * a file that churned back to where it started is not a change at all.
 */
export interface LakeMembershipDiffEntry {
  fabFileId: string;
  /** The event that set the end state - the handle for a future per-event drill-in. */
  eventId: string;
  changedAt: Date;
  /** Whether an automated ingestion pipeline or a person drove that final move. */
  origin: LakeMembershipChangeOrigin;
  principalKind: LakeMembershipChangePrincipalKind;
  principalId: string;
  /** Resolved display name when the principal is a user AND still resolvable; otherwise absent and
   * the consumer falls back to the opaque `principalId`. Never an email. */
  principalName?: string;
  onBehalfOfUserId?: string;
  onBehalfOfName?: string;
  /** Membership flips inside the window: 1 for a plain join or leave, more when the file churned.
   * The earlier flips are folded away here, so a reader can tell a settled move from a noisy one. */
  flips: number;
}

/** Why `unchangedCount` is absent. Both mean "not measured", never "zero". */
export type LakeMembershipDiffUnknownReason =
  /** The window starts before the lake's oldest retained event, so a file with no rows in it may
   * have joined during the window rather than sat through it. */
  | 'window-predates-log'
  /** The read hit its cap, so the oldest part of the window is missing the same way. */
  | 'window-truncated';

export interface LakeMembershipDiffView {
  lakeId: string;
  /** Exclusive lower bound - a change exactly at `from` belongs to the window before this one. */
  from: Date;
  /** Inclusive upper bound. */
  to: Date;
  /** Files that are members at `to` but were not at `from`, newest move first. */
  added: LakeMembershipDiffEntry[];
  /** Files that were members at `from` but are not at `to`, newest move first. */
  removed: LakeMembershipDiffEntry[];
  /**
   * How many files were members at BOTH ends. Absent when it cannot be known - see
   * `unchangedUnknownReason`. A consumer must render that as unknown, not as zero.
   *
   * A count rather than ids: an unchanged file has no move to attribute, and the membership list
   * itself is already answerable from the files collection.
   */
  unchangedCount?: number;
  unchangedUnknownReason?: LakeMembershipDiffUnknownReason;
  /**
   * Members at `to` that joined inside the window with no event to show for it: the file-create
   * doors (`generate-presigned-urls-batch`, `fabFileService/create`, the Slack lake ingest) tag a
   * file into a lake without recording one, so the file's own creation time is the only evidence.
   *
   * They are in neither `added` (no event to attribute) nor `unchangedCount` (they did not sit
   * through), so a non-zero value means `added` is a FLOOR on the window's intake. Reported even
   * when `unchangedCount` is absent, since it rests on the live read rather than on log coverage;
   * under `truncated` it may also include a join whose event fell off the tail.
   */
  addedWithoutEventCount: number;
  /** The lake's oldest retained event, absent when it has none. Lets a consumer caption the diff
   * with how far back the log can be believed. */
  logStartsAt?: Date;
  /**
   * True when the read hit its cap, so `added`/`removed` are a window on the window: moves in the
   * earliest part of the span are missing. The listed entries are then unreliable in DIRECTION too,
   * not only incomplete - a file whose earlier flip fell off the tail is classified from its first
   * surviving event, so a remove-then-readd can surface as a plain `added`. A consumer must caption
   * a truncated diff as partial rather than present it as the window's changes.
   */
  truncated: boolean;
  generatedAt: Date;
  /** Display names for the user ids appearing as principals, keyed by id. Unresolvable ids are
   * absent so the consumer's raw-id fallback fires. */
  userNames: Record<string, string>;
}
