import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { LAKE_ACCESS_PRINCIPAL_KINDS, type LakeAccessPrincipalKind } from './LakeAccessEventTypes';

// -- Lake Membership Change Event ------------------------------------------------------------
//
// The durable trail a file's join to or leave from a lake leaves behind (#3052): one row per
// accepted membership write, answering "what did this lake contain last month" - a question
// nothing in this codebase can answer today, since removal is a hard `$pull` on the FabFile tag
// array with no soft delete or versioning.
//
// Deliberately NOT folded into LakeConfigChangeEvent's action list, even though the issue that
// created this file's sibling first suggested it as the natural home. That collection's `changes`
// field is a diff on `IDataLake` document fields (`ILakeConfigFieldChange[]`, keyed by
// `LakeConfigChangeField`) - a membership change is an edge on a (lake, file) PAIR, not a
// before/after on a lake field, so recording one there would mean either inventing a fake field
// diff or leaving `changes` empty, which `recordLakeConfigChange` already treats as "nothing
// happened" and refuses to persist. The two collections also want opposite volume/retention
// profiles for the same reason LakeConfigChangeEvent itself split off LakeAccessEventModel: a
// membership event fires on every file add/remove (LakeAccessEvent's read-volume order of
// magnitude), while a config event is rare and deliberate. A sibling collection, sharing the
// config event's append-only shape and the principal vocabulary both audit trails alias from
// LakeAccessEventTypes, is the same choice LakeConfigChangeEvent itself made against
// LakeAccessEventModel - see that file's own header.
//
// SCOPE: the event, its vocabulary, the write path that records it, and the read side that diffs
// a lake's membership between two instants. Still append-only: the repository below exposes
// `record` plus reads and nothing else, matching LakeConfigChangeEventModel's own read/append
// split.

/** Mirrors the read model's vocabulary deliberately (aliased, not re-declared), the same choice
 * LakeConfigChangeEventTypes makes and for the same reason: one principal shape across every
 * audit trail this codebase keeps. */
export const LAKE_MEMBERSHIP_CHANGE_PRINCIPAL_KINDS = LAKE_ACCESS_PRINCIPAL_KINDS;
export type LakeMembershipChangePrincipalKind = LakeAccessPrincipalKind;

/** A file joining or leaving a lake. Two values, not a boolean: `action` reads the same way a
 * config event's `action` does, and a boolean here would force every reader to remember which
 * polarity means what. */
export const LAKE_MEMBERSHIP_CHANGE_ACTIONS = ['added', 'removed'] as const;
export type LakeMembershipChangeAction = (typeof LAKE_MEMBERSHIP_CHANGE_ACTIONS)[number];

/**
 * Who INITIATED the write: an automated ingestion pipeline (today, a Google Drive connector
 * sync) or a person acting through an interactive door (a session, or an API key acting on a
 * person's behalf).
 *
 * A field of its OWN, not inferred from `principalKind`: a connector sync runs as a real user id
 * (`connection.connectedBy`) with `isAdmin: true` - see `driveLakeIngest.ts`'s `membershipActor` -
 * so `principalKind` resolves to the same `'user'` a session write would. Only the call site that
 * runs the automated sync KNOWS it is one; every membership-write entry point therefore states
 * this explicitly rather than it being guessed from the principal shape.
 */
export const LAKE_MEMBERSHIP_CHANGE_ORIGINS = ['connector', 'person'] as const;
export type LakeMembershipChangeOrigin = (typeof LAKE_MEMBERSHIP_CHANGE_ORIGINS)[number];

export interface ILakeMembershipChangeEvent {
  principalKind: LakeMembershipChangePrincipalKind;
  principalId: string;
  /** Set when a key/agent principal acted for a human, mirroring `ILakeConfigChangeEvent`'s field
   * of the same name - see that type for the full rationale. */
  onBehalfOfUserId?: string;
  /** The LAKE's org scope at write time, for an org-wide "what changed across our lakes" query -
   * the same reasoning as `ILakeConfigChangeEvent.organizationId`. */
  organizationId?: string;
  dataLakeId: string;
  fabFileId: string;
  action: LakeMembershipChangeAction;
  origin: LakeMembershipChangeOrigin;
  /** Computed at write time from the fixed retention; TTL-indexed. */
  expiresAt: Date;
}

export interface ILakeMembershipChangeEventDocument extends ILakeMembershipChangeEvent, IMongoDocument {}

export interface RecordLakeMembershipChangeInput {
  principalKind: LakeMembershipChangePrincipalKind;
  principalId: string;
  onBehalfOfUserId?: string;
  organizationId?: string;
  dataLakeId: string;
  fabFileId: string;
  action: LakeMembershipChangeAction;
  origin: LakeMembershipChangeOrigin;
}

/**
 * Read/append only by construction, matching `ILakeConfigChangeEventRepository`: no update or
 * delete is exposed. A membership event is a claim about something that already happened -
 * editing one is never a legitimate operation, so the capability simply does not exist here.
 */
export interface ILakeMembershipChangeEventRepository extends Pick<
  IBaseRepository<ILakeMembershipChangeEventDocument>,
  'find' | 'findOne' | 'findById' | 'count'
> {
  record(input: RecordLakeMembershipChangeInput): Promise<ILakeMembershipChangeEventDocument>;
  listByLake(lakeId: string, opts?: { limit?: number }): Promise<ILakeMembershipChangeEventDocument[]>;
  /**
   * Every event for the lake strictly AFTER `since`, newest first, capped by `limit`.
   *
   * No upper bound on purpose: a diff ending in the past still has to rewind today's membership
   * back to the window's end, which needs the events recorded since then. Truncation therefore
   * drops the OLDEST rows, which is the end a caller can honestly report as uncovered.
   */
  listByLakeSince(
    lakeId: string,
    since: Date,
    opts?: { limit?: number }
  ): Promise<ILakeMembershipChangeEventDocument[]>;
  /**
   * When this lake's oldest RETAINED event was written, or undefined when it has none. The only
   * evidence available for how far back the log can be believed: rows expire on the TTL, and
   * nothing records when collection began, so a window reaching past this instant cannot be
   * answered with a membership set - only with the events that happen to survive.
   */
  oldestEventAt(lakeId: string): Promise<Date | undefined>;
}

type AssertTrue<T extends true> = T;

/**
 * COMPILE-TIME GUARD on the append-only shape above, mirroring
 * `LakeConfigChangeEventRepositoryIsAppendOnly` and for the identical reason stated there: the
 * concrete class inherits `update`/`delete` from `BaseRepository` at runtime, and this is the
 * only thing withholding them from the type a caller actually sees.
 */
export type LakeMembershipChangeEventRepositoryIsAppendOnly = AssertTrue<
  Exclude<
    keyof ILakeMembershipChangeEventRepository,
    'record' | 'listByLake' | 'listByLakeSince' | 'oldestEventAt' | 'find' | 'findOne' | 'findById' | 'count'
  > extends never
    ? true
    : false
>;
