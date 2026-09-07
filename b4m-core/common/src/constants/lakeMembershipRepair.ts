/**
 * Planning the repair of duplicated lake membership.
 *
 * `summarizeLakeMembership` describes what is there; this decides what to propose about it. Split
 * the way `converge` splits `planLakeConvergenceRun` from its execution, and pure for the same
 * reason: the rules that decide whether to touch a customer's membership should be readable and
 * testable without a database in the loop.
 *
 * Nothing here mutates anything. A plan is a proposal.
 */

import { byNewestFirst, type DuplicateBucket, type DuplicateGroup } from './lakeMembershipHealth';
import type { ILakeMembershipDecision } from '../types/entities/LakeMembershipDecisionTypes';

/**
 * What the plan proposes for one duplicate group.
 *
 * `collapse` is the only action that executes without an owner deciding, and it is offered ONLY for
 * a group whose identity is proven (see `summarizeLakeMembership`'s `proven-identical`). Everything
 * else asks, because the alternative is a tool that silently deletes membership on a guess.
 */
export const REPAIR_ACTIONS = ['collapse', 'decide'] as const;
export type RepairAction = (typeof REPAIR_ACTIONS)[number];

/** The decisions an owner can record for a group that needs one. */
export const REPAIR_DECISIONS = ['keep-newest', 'keep-specific', 'keep-both'] as const;
export type RepairDecision = (typeof REPAIR_DECISIONS)[number];

/**
 * A recorded owner decision, and the tombstone that keeps it from being re-asked.
 *
 * Modelled on the declined-proposal tombstone (`IDataLakeProposal`): identity, who, when, and a hash
 * that survives so a MATERIALLY CHANGED group is surfaced again rather than suppressed silently. The
 * hash is what makes "keep both" sticky without making it permanent - if one of the pair is replaced
 * later, that is a new question and the owner should get it back.
 *
 * Who/when/which-lake live on the record rather than only in the stored document because
 * `PlannedRepairGroup.settledBy` is typed to THIS interface: a wider persistence type is erased at
 * that boundary, and "why is this not being offered to me" is unanswerable without them.
 */
export interface MembershipDecisionRecord {
  /** The lake this was decided in. One plan must never mix lakes - see `planMembershipRepair`. */
  dataLakeId: string;
  fileName: string;
  decision: RepairDecision;
  /**
   * Set only for `keep-specific`; the member the owner chose to keep. Required-and-nullable rather
   * than optional, matching the persisted row: a decision that came back from the collection always
   * carries the field, and the parity assertion at the foot of this file pins the two declarations
   * to each other.
   */
  keptFabFileId: string | null;
  /** `groupIdentity` at the time the decision was made. A mismatch re-opens the question. */
  groupIdentity: string;
  decidedByUserId: string;
  decidedAt: Date;
}

/**
 * One row, two declarations: `MembershipDecisionRecord` above is what the planner reads and
 * `ILakeMembershipDecision` is what persists. A field added to one and not the other surfaces at the
 * boundary that erases the difference, on live data.
 *
 * This lives in the SOURCE file, not beside the tests that motivated it: every tsconfig that covers
 * the packages this type crosses excludes test files from the typecheck, so an assertion of this
 * shape in a `.test.ts` is compiled by nothing and silently guarantees nothing. Costs nothing at
 * runtime, fails the build both ways.
 *
 * `source` is deliberately omitted: the planner does not branch on where a ruling came from.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _decisionRecordParity: MutuallyAssignable<
  MembershipDecisionRecord,
  Omit<ILakeMembershipDecision, 'source'>
> = true;
void _decisionRecordParity;

export interface PlannedRepairGroup {
  fileName: string;
  bucket: DuplicateBucket;
  action: RepairAction;
  /** Stable across runs given unchanged members; the tombstone key. */
  groupIdentity: string;
  /** Newest first, guaranteed by the plan rather than inherited. For `collapse`, everything after the first is removed. */
  members: DuplicateGroup['members'];
  /** Members this plan would remove from the lake if executed as proposed. Empty for `decide`. */
  removeFabFileIds: string[];
  /** Present when a prior decision applies and is still valid - the group is NOT re-asked. */
  settledBy?: MembershipDecisionRecord;
  /**
   * Present when a prior decision exists but its identity no longer matches: the group IS re-asked,
   * and this is the superseded record, carried so a surface can say what was decided before rather
   * than present the question as though it were new. Informative, never binding.
   */
  priorDecision?: MembershipDecisionRecord;
  /**
   * On a settled group only: what `settledBy` would still remove from the group AS IT STANDS NOW.
   *
   * `keep-both` is the only decision for which an intact group is the correct steady state, so a
   * non-empty list here means a `keep-newest`/`keep-specific` decision was recorded but never carried
   * out - had it been, the group would have shrunk, changing its identity and re-opening it. Without
   * this the plan reports such a lake as clean forever. It is a SIGNAL, not an instruction:
   * `removeFabFileIds` stays empty on every non-`collapse` group, so an executor reading only that
   * field is still correct.
   */
  outstandingRemovalFabFileIds?: string[];
}

export interface MembershipRepairPlan {
  /** Groups that would collapse with no owner input. */
  collapsible: PlannedRepairGroup[];
  /** Groups needing a decision, worst-understood first. */
  needsDecision: PlannedRepairGroup[];
  /** Groups a prior decision already settled, carried so a surface can show what it is suppressing. */
  settled: PlannedRepairGroup[];
  /** Total members this plan would remove if executed with no decisions supplied. */
  removalCount: number;
}

/**
 * A stable fingerprint of a group's membership, used as the tombstone key alongside the file name.
 *
 * Built from the member ids AND their fingerprints AND their sizes, sorted, so it is:
 *  - stable across runs for unchanged members (ids sorted, not read order), and
 *  - sensitive to a member being added, removed, re-chunked to different text, or re-exported.
 *
 * The second property is the point. Keying on ids alone would let a document be replaced under a
 * settled decision and stay suppressed forever; keying on hashes alone would collide across groups
 * whose members all lack a fingerprint, which is most of an existing backlog.
 *
 * `fileSize` is in the key because it is in `classifyGroup`'s: a size disagreement is what moves a
 * group out of `proven-identical`, so a re-export (same extracted text, different bytes) is exactly
 * the material change this key promises to surface. Covering a strict subset of the bucket's inputs
 * would leave that one change suppressed indefinitely.
 *
 * The `:` and `|` delimiters are safe: ObjectId strings, hex fingerprints and decimal sizes contain
 * neither.
 */
export function groupIdentity(group: Pick<DuplicateGroup, 'members'>): string {
  return group.members
    .map(m => `${m.fabFileId}:${m.serverTextHash ?? '-'}:${m.fileSize ?? '-'}`)
    .sort()
    .join('|');
}

/** Worst-understood first: unverified, then differing. Collapsible groups are listed separately. */
const DECISION_ORDER: Record<DuplicateBucket, number> = { unverified: 0, differing: 1, 'proven-identical': 2 };

/**
 * Build a repair plan from a membership report's duplicate groups and any decisions already on record.
 *
 * A group is settled when a decision exists for its file name AND that decision's `groupIdentity`
 * still matches - see `groupIdentity` for why the second half matters. A decision whose identity has
 * moved on does NOT settle the group, but it still disqualifies it from the automatic arm: see the
 * routing comment below.
 *
 * Preconditions on `decisions`, both owed by the caller: every record belongs to the SAME lake as
 * `duplicateGroups` (nothing here re-checks `dataLakeId`), and there is at most one record per file
 * name. A duplicate file name is resolved deterministically anyway - the record matching the group's
 * current identity wins, otherwise the last - so an append-only store cannot flip the plan on Mongo's
 * return order, but the store should still hold a unique index on (lake, file name).
 */
export function planMembershipRepair(
  duplicateGroups: DuplicateGroup[],
  decisions: MembershipDecisionRecord[] = []
): MembershipRepairPlan {
  const byFileName = new Map<string, MembershipDecisionRecord[]>();
  for (const decision of decisions) {
    const existing = byFileName.get(decision.fileName);
    if (existing) existing.push(decision);
    else byFileName.set(decision.fileName, [decision]);
  }

  const collapsible: PlannedRepairGroup[] = [];
  const needsDecision: PlannedRepairGroup[] = [];
  const settled: PlannedRepairGroup[] = [];

  for (const group of duplicateGroups) {
    const identity = groupIdentity(group);
    // Re-sorted rather than trusted, so `members` is newest-first on every planned group as its type
    // claims. Removal is POSITIONAL, so a caller handing members over in some other order would
    // otherwise silently delete the wrong copies. A no-op on a real report - `summarizeLakeMembership`
    // already emits this order - but the plan is the last place that can still guarantee it.
    const members = [...group.members].sort(byNewestFirst);
    const candidates = byFileName.get(group.fileName) ?? [];
    // Prefer a record that still matches; otherwise the last, so the outcome does not depend on the
    // order the store happened to return them in.
    const prior = candidates.find(d => d.groupIdentity === identity) ?? candidates[candidates.length - 1];

    // A settled group proposes nothing, whatever its bucket - including a proven-identical one. An
    // owner who said "keep both" about a pair must not have it collapsed by the automatic arm on the
    // next run; that would make the decision advisory rather than binding.
    if (prior?.groupIdentity === identity) {
      settled.push({
        fileName: group.fileName,
        bucket: group.bucket,
        action: 'decide',
        groupIdentity: identity,
        members,
        removeFabFileIds: [],
        settledBy: prior,
        outstandingRemovalFabFileIds: membersRemovedByDecision({ members }, prior.decision, prior.keptFabFileId),
      });
      continue;
    }

    // A group ANY decision exists for never falls to the automatic arm, even with the identity stale.
    //
    // The two are not independent: `classifyGroup` returns `unverified` until every member carries a
    // fingerprint, so reaching `proven-identical` REQUIRES a member to gain one - which necessarily
    // changes `groupIdentity`. Routing a stale-identity group by bucket alone therefore auto-collapses
    // every "keep both" the moment its members get hashed (a re-chunk, a bulk passage rebuild), which
    // is the one thing "keep both" has to prevent. The identity says whether to ask again, not whether
    // a human has ever ruled here; only the second question gates the arm that deletes without asking.
    if (!prior && group.bucket === 'proven-identical') {
      // Keep the newest, remove the rest. Safe without asking ONLY because identity is proven: the
      // copies are the same text at the same size, so "which one" cannot matter.
      collapsible.push({
        fileName: group.fileName,
        bucket: group.bucket,
        action: 'collapse',
        groupIdentity: identity,
        members,
        removeFabFileIds: members.slice(1).map(m => m.fabFileId),
      });
      continue;
    }

    needsDecision.push({
      fileName: group.fileName,
      bucket: group.bucket,
      action: 'decide',
      groupIdentity: identity,
      members,
      // A `decide` group removes NOTHING until the owner says so. This is the field an execution
      // path reads, so leaving it empty is what makes "POST with no decisions touches only bucket A"
      // a property of the plan rather than a rule the executor has to remember.
      removeFabFileIds: [],
      ...(prior && { priorDecision: prior }),
    });
  }

  needsDecision.sort(
    (a, b) => DECISION_ORDER[a.bucket] - DECISION_ORDER[b.bucket] || a.fileName.localeCompare(b.fileName)
  );
  collapsible.sort((a, b) => a.fileName.localeCompare(b.fileName));
  settled.sort((a, b) => a.fileName.localeCompare(b.fileName));

  return {
    collapsible,
    needsDecision,
    settled,
    removalCount: collapsible.reduce((sum, g) => sum + g.removeFabFileIds.length, 0),
  };
}

/**
 * Which members a recorded decision removes from a group.
 *
 * Separate from planning because it runs at EXECUTION time against the decision the owner actually
 * sent, which may differ from anything the plan proposed. Returns an empty list for `keep-both`,
 * and for a `keep-specific` naming a member that is no longer in the group - a stale decision must
 * remove nothing rather than fall back to a default that the owner did not choose.
 *
 * `keep-newest` sorts before slicing rather than trusting the caller's order: the parameter is a bare
 * `Pick<..., 'members'>`, so an executor that re-read members from Mongo in natural order would get a
 * silently wrong deletion with no type error. `byNewestFirst` is shared for the same reason.
 */
export function membersRemovedByDecision(
  group: Pick<PlannedRepairGroup, 'members'>,
  decision: RepairDecision,
  keptFabFileId?: string | null
): string[] {
  if (decision === 'keep-both') return [];
  if (decision === 'keep-newest')
    return [...group.members]
      .sort(byNewestFirst)
      .slice(1)
      .map(m => m.fabFileId);
  const kept = group.members.find(m => m.fabFileId === keptFabFileId);
  if (!kept) return [];
  return group.members.filter(m => m.fabFileId !== kept.fabFileId).map(m => m.fabFileId);
}
