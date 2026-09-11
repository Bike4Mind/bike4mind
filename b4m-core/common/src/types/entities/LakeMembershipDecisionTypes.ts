import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';
import { REPAIR_DECISIONS, type RepairDecision } from '../../constants/lakeMembershipRepair';

// -- Lake membership decision ---------------------------------------------------------------------
//
// The durable half of the membership repair (#2245). `planMembershipRepair` is pure and takes the
// owner's prior decisions as an argument; this is where those decisions live between runs.
//
// A row is a TOMBSTONE, in the same sense as a declined proposal: it exists so the repair does not
// re-ask a question the owner already answered. "Keep both" is the case that makes it necessary -
// deliberate retention of a superseded document is a real outcome, and without a record the next
// plan proposes the same collapse forever until someone gives in and accepts it.
//
// Not a TTL collection, unlike ILakeMembershipRemoval next door. That record is a short-lived
// authorization token; this one is a decision, and a decision that expired after thirty minutes
// would be no decision at all. Staleness is handled by `groupIdentity` instead of by a clock: a row
// stops applying the moment the group it was made about changes, which is what keeps "sticky"
// from becoming "permanent". See `groupIdentity` in constants/lakeMembershipRepair.ts.
//
// Types live here rather than in the model because the services that read them run in
// b4m-core/services, which cannot import @bike4mind/database - the same split
// DataLakeAccessGrantTypes and DataLakeProposalTypes use.

/**
 * One owner ruling about one duplicated file name in one lake.
 *
 * Keyed on `(dataLakeId, fileName)` and not on the members, because the QUESTION is about the name:
 * if a third copy of `policy.md` arrives, the owner is not being asked a new question, they are
 * being asked the old one again with more evidence - which is exactly what `groupIdentity` detects
 * and re-opens. A member-keyed row would leave the third copy silently unasked-about.
 */
export interface ILakeMembershipDecision {
  dataLakeId: string;
  /** The duplicated name this ruling is about. Matches `DuplicateGroup.fileName`. */
  fileName: string;
  decision: RepairDecision;
  /** Set only for `keep-specific`; null otherwise. The member the owner chose to keep. */
  keptFabFileId: string | null;
  /**
   * `groupIdentity` of the group as it stood when the ruling was made. The plan applies this row
   * only while that still matches - see the module note above.
   */
  groupIdentity: string;
  /** Who ruled. Audit only; the manage gate on the route is the authorization. */
  decidedByUserId: string;
  decidedAt: Date;
  /**
   * Where the ruling came from. `repair` is the plan surface; `admission` is the upload-time offer
   * (#2238), which writes the SAME row so a repair run does not immediately re-ask about a pair the
   * uploader just deliberately created. One vocabulary, one collection, deliberately.
   */
  source: LakeMembershipDecisionSource;
}

export const LAKE_MEMBERSHIP_DECISION_SOURCES = ['repair', 'admission'] as const;
export type LakeMembershipDecisionSource = (typeof LAKE_MEMBERSHIP_DECISION_SOURCES)[number];

/** Re-exported for the model's schema enum, so the persisted values cannot drift from the planner's. */
export const LAKE_MEMBERSHIP_DECISION_VALUES = REPAIR_DECISIONS;

export interface ILakeMembershipDecisionDocument extends ILakeMembershipDecision, IMongoDocument {}

export interface ILakeMembershipDecisionRepository extends IBaseRepository<ILakeMembershipDecisionDocument> {
  /**
   * Record the owner's ruling for `(dataLakeId, fileName)`, replacing any prior one in place.
   * Idempotent on that natural key (enforced by a unique index - see the model): re-answering a
   * re-opened question overwrites the stale row rather than accumulating a history nothing reads.
   */
  upsertDecision(input: ILakeMembershipDecision): Promise<ILakeMembershipDecisionDocument>;
  /** Every ruling on record for one lake - the plan's input. */
  listByLake(dataLakeId: string): Promise<ILakeMembershipDecisionDocument[]>;
  /**
   * Drop the ruling for one name, so the plan asks about it again. The owner-facing "undo my
   * decision" path; returns whether a row was actually removed.
   */
  clearDecision(dataLakeId: string, fileName: string): Promise<boolean>;
  /**
   * Cascade-drop every ruling for one lake, called by the purge sweep. A ruling that outlives its
   * lake guards a name with no destination, and nothing can ever read it again. Idempotent, so a
   * DLQ retry of the sweep is safe.
   */
  deleteForLake(dataLakeId: string): Promise<number>;
}
