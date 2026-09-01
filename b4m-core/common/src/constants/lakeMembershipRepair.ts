/**
 * Planning the repair of duplicated lake membership (#2245).
 *
 * `summarizeLakeMembership` describes what is there; this decides what to propose about it. Split
 * the way `converge` splits `planLakeConvergenceRun` from its execution, and pure for the same
 * reason: the rules that decide whether to touch a customer's membership should be readable and
 * testable without a database in the loop.
 *
 * Nothing here mutates anything. A plan is a proposal.
 */

import type { DuplicateBucket, DuplicateGroup } from './lakeMembershipHealth';

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
 */
export interface MembershipDecisionRecord {
  fileName: string;
  decision: RepairDecision;
  /** Set only for `keep-specific`; the member the owner chose to keep. */
  keptFabFileId?: string | null;
  /** `groupIdentity` at the time the decision was made. A mismatch re-opens the question. */
  groupIdentity: string;
}

export interface PlannedRepairGroup {
  fileName: string;
  bucket: DuplicateBucket;
  action: RepairAction;
  /** Stable across runs given unchanged members; the tombstone key. */
  groupIdentity: string;
  /** Newest first. For `collapse`, everything after the first is what would be removed. */
  members: DuplicateGroup['members'];
  /** Members this plan would remove from the lake if executed as proposed. Empty for `decide`. */
  removeFabFileIds: string[];
  /** Present when a prior decision applies and is still valid - the group is NOT re-asked. */
  settledBy?: MembershipDecisionRecord;
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
 * Built from the member ids AND their content fingerprints, sorted, so it is:
 *  - stable across runs for unchanged members (ids sorted, not read order), and
 *  - sensitive to a member being added, removed or re-chunked with different text.
 *
 * The second property is the point. Keying on ids alone would let a document be replaced under a
 * settled decision and stay suppressed forever; keying on hashes alone would collide across groups
 * whose members all lack a fingerprint, which is most of an existing backlog.
 */
export function groupIdentity(group: Pick<DuplicateGroup, 'members'>): string {
  return group.members
    .map(m => `${m.fabFileId}:${m.serverTextHash ?? '-'}`)
    .sort()
    .join('|');
}

/** Worst-understood first: unverified, then differing. Collapsible groups are listed separately. */
const DECISION_ORDER: Record<DuplicateBucket, number> = { unverified: 0, differing: 1, 'proven-identical': 2 };

/**
 * Build a repair plan from a membership report's duplicate groups and any decisions already on record.
 *
 * A group is settled when a decision exists for its file name AND that decision's `groupIdentity`
 * still matches - see `groupIdentity` for why the second half matters.
 */
export function planMembershipRepair(
  duplicateGroups: DuplicateGroup[],
  decisions: MembershipDecisionRecord[] = []
): MembershipRepairPlan {
  const byFileName = new Map(decisions.map(d => [d.fileName, d]));

  const collapsible: PlannedRepairGroup[] = [];
  const needsDecision: PlannedRepairGroup[] = [];
  const settled: PlannedRepairGroup[] = [];

  for (const group of duplicateGroups) {
    const identity = groupIdentity(group);
    const prior = byFileName.get(group.fileName);
    const isSettled = prior?.groupIdentity === identity;

    // A settled group proposes nothing, whatever its bucket - including a proven-identical one. An
    // owner who said "keep both" about a pair must not have it collapsed by the automatic arm on the
    // next run; that would make the decision advisory rather than binding.
    if (isSettled && prior) {
      settled.push({
        fileName: group.fileName,
        bucket: group.bucket,
        action: 'decide',
        groupIdentity: identity,
        members: group.members,
        removeFabFileIds: [],
        settledBy: prior,
      });
      continue;
    }

    if (group.bucket === 'proven-identical') {
      // Keep the newest, remove the rest. Safe without asking ONLY because identity is proven: the
      // copies are the same text at the same size, so "which one" cannot matter.
      collapsible.push({
        fileName: group.fileName,
        bucket: group.bucket,
        action: 'collapse',
        groupIdentity: identity,
        members: group.members,
        removeFabFileIds: group.members.slice(1).map(m => m.fabFileId),
      });
      continue;
    }

    needsDecision.push({
      fileName: group.fileName,
      bucket: group.bucket,
      action: 'decide',
      groupIdentity: identity,
      members: group.members,
      // A `decide` group removes NOTHING until the owner says so. This is the field an execution
      // path reads, so leaving it empty is what makes "POST with no decisions touches only bucket A"
      // a property of the plan rather than a rule the executor has to remember.
      removeFabFileIds: [],
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
 */
export function membersRemovedByDecision(
  group: Pick<PlannedRepairGroup, 'members'>,
  decision: RepairDecision,
  keptFabFileId?: string | null
): string[] {
  if (decision === 'keep-both') return [];
  if (decision === 'keep-newest') return group.members.slice(1).map(m => m.fabFileId);
  const kept = group.members.find(m => m.fabFileId === keptFabFileId);
  if (!kept) return [];
  return group.members.filter(m => m.fabFileId !== kept.fabFileId).map(m => m.fabFileId);
}
