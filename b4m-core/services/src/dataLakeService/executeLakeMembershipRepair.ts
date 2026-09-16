import { NotFoundError } from '@bike4mind/common';
import {
  membersRemovedByDecision,
  type MembershipRepairPlan,
  type PlannedRepairGroup,
  type RepairDecision,
} from '@bike4mind/common';
import { removeFileFromDataLake, type RemoveFileFromDataLakeAdapters } from './removeFileFromDataLake';
import type { MembershipActor } from './lakeMembership';

/**
 * Executing a membership repair plan (#2245).
 *
 * `planMembershipRepair` decides what to propose; this carries it out. Split the way `converge`
 * splits `planLakeConvergenceRun` from its execution, and for the same reason: every rule about
 * whether to touch a customer's membership is readable and testable in the pure module, and this
 * one only has to be right about HOW.
 *
 * Removal is membership only - `removeFileFromDataLake` pulls the lake's tags off the FabFile; the
 * file and its chunks survive, which is what makes the operation recoverable. Two qualifications
 * that door spells out and this one inherits in bulk: a second lake sharing this lake's
 * fileTagPrefix loses the shared tag, and outright loses a member it held by prefix alone; and each
 * removal also mints a 30-minute restore row and recomputes stats, which can activate a draft lake.
 * The membership-only property is pinned at `removeFileFromLake`'s single `pullTagsByFabFileId`, not
 * by the tests here - they mock the callee, so what they assert is delegation.
 *
 * NOT gated here, the same split `converge` uses: the service plans and the handler decides whether
 * it may run. In practice this is not an ungated door - every removal reaches `removeFileFromLake`'s
 * `resolveCanManageLake`, so an unauthorized caller is refused on the first member and every one
 * after - but a route leaning on that gets N failure entries instead of one refusal.
 *
 * Two controls a route must supply that do NOT exist yet, stated because the natural assumption is
 * that they do. The convergence kill switch cannot halt this: `isConvergenceHalted` returns early
 * unless the work is convergence-origin and resolves a pause flag over queued embedding work, and a
 * repair enqueues nothing. And nothing caps the wave - the planner truncates nothing, and
 * `maxGroups`/`maxGroupMembers` are optional payload caps on the health report, not safety caps on a
 * repair. Compare `converge`, which carries a hard `MAX_CONVERGENCE_WAVE`.
 */

/** What the caller asked to happen beyond the plan's automatic arm, keyed by file name. */
export interface MembershipRepairDecisionInput {
  fileName: string;
  decision: RepairDecision;
  keptFabFileId?: string | null;
  /**
   * `groupIdentity` of the group the owner actually reviewed, so a ruling cannot land on a group
   * that moved underneath it. Optional for a caller with none to offer, but the exposure is real
   * rather than theoretical: a decision whose identity still matches settles its group, and settled
   * groups are never acted on here - so the groups a live decision CAN reach are the ones with no
   * prior ruling plus exactly the ones whose membership changed since review. `keep-newest` is
   * positional, so on those a copy that arrived after review silently becomes the survivor and the
   * copy the owner elected to keep is the one removed.
   */
  groupIdentity?: string;
}

export interface MembershipRepairOutcome {
  /** Members whose lake membership was removed, in the order they were removed. */
  removedFabFileIds: string[];
  /** Groups acted on, so a surface can report per-file rather than only a total. */
  groupsActedOn: { fileName: string; removedFabFileIds: string[] }[];
  /**
   * Removals attempted that threw, with the reason. One member failing must not abandon the rest -
   * a half-applied repair the owner can re-run is recoverable; an abandoned one silently is not.
   */
  failures: { fabFileId: string; fileName: string; error: string }[];
  /**
   * Decisions withheld because the group moved since it was reviewed. Reported, not dropped: the
   * owner has to be re-asked, and a silent skip is indistinguishable from a repair that found
   * nothing to do.
   */
  staleDecisions: { fileName: string; reviewedGroupIdentity: string; currentGroupIdentity: string }[];
  /**
   * Decisions withheld because two arrived for one file name. Applying either would make a
   * destructive outcome depend on array position - `[keep-both, keep-newest]` removes members and
   * the reverse removes none - so neither is applied and both are reported.
   */
  duplicateDecisions: string[];
  /**
   * Removals whose restore row failed to write, so re-adding is refused immediately rather than
   * after the 30-minute TTL. A subset of `removedFabFileIds` - the membership removal itself stood.
   *
   * A bulk caller cannot infer this: the removal door writes that row best-effort in a catch that
   * only warns, so without it a surface reports "removed 40" with no signal that k of them were
   * never undoable. Empty is the ordinary case.
   */
  removedWithoutRestoreToken: string[];
  /** True when the run stopped at MAX_MEMBERSHIP_REPAIR_REMOVALS with work still outstanding. */
  truncated: boolean;
}

/**
 * Hard ceiling on removals in one run, mirroring MAX_CONVERGENCE_WAVE on the sibling this executor
 * is modelled on. The plan carries no cap of its own - `maxGroups`/`maxGroupMembers` are optional
 * payload options on the health report, not safety bounds - so without this a hand-crafted plan is
 * an unbounded sequential wave of removals, each one a read plus a `$pull` plus a full lake-stats
 * recompute.
 */
export const MAX_MEMBERSHIP_REPAIR_REMOVALS = 200;

/**
 * Which members a group loses in this run.
 *
 * The plan's own `removeFabFileIds` is the ONLY source for the automatic arm - it is empty on every
 * `decide` group by construction (see `planMembershipRepair`), so an executor that read it for every
 * group in the plan would still be correct. A supplied decision is what turns a `decide` group into
 * removals, and it is resolved against the group as the PLAN saw it, not re-derived.
 *
 * That the plan is the thing the owner reviewed is a PRECONDITION, and the route cannot honour it:
 * nothing persists a `MembershipRepairPlan`, so a POST has to re-plan and hands over a plan computed
 * at request time. `groupIdentity` on the decision is what carries the reviewed group across that
 * gap; a mismatch withholds the ruling rather than applying it to a group the owner never saw. The
 * automatic arm is unaffected - a `collapse` group's removals come from the plan, never a decision.
 */
function removalsForGroup(
  group: PlannedRepairGroup,
  byFileName: Map<string, MembershipRepairDecisionInput>
): { removals: string[]; stale?: MembershipRepairOutcome['staleDecisions'][number] } {
  if (group.action === 'collapse') return { removals: group.removeFabFileIds };
  const decision = byFileName.get(group.fileName);
  if (!decision) return { removals: [] };
  if (decision.groupIdentity && decision.groupIdentity !== group.groupIdentity) {
    return {
      removals: [],
      stale: {
        fileName: group.fileName,
        reviewedGroupIdentity: decision.groupIdentity,
        currentGroupIdentity: group.groupIdentity,
      },
    };
  }
  return { removals: membersRemovedByDecision(group, decision.decision, decision.keptFabFileId) };
}

/**
 * Execute a repair plan: the automatic arm always, plus whatever the owner decided.
 *
 * With no decisions supplied this removes bucket A only and leaves B and C untouched - not by a rule
 * this function remembers, but because the plan's `decide` groups carry an empty `removeFabFileIds`
 * and no decision resolves to anything. That is the property `planMembershipRepair` exists to make
 * true, and this executor is the caller it was made true for.
 *
 * `settled` groups are never acted on. They carry a prior decision that already suppressed them, and
 * their `outstandingRemovalFabFileIds` is a SIGNAL about work never carried out, not an instruction -
 * acting on it here would let a stale tombstone remove membership with no owner in the loop.
 */
export async function executeLakeMembershipRepair(
  actor: MembershipActor,
  dataLakeId: string,
  plan: MembershipRepairPlan,
  decisions: MembershipRepairDecisionInput[],
  adapters: RemoveFileFromDataLakeAdapters
): Promise<MembershipRepairOutcome> {
  const { db, logger } = adapters;

  // Built with duplicates REMOVED rather than last-wins: applying either of two rulings for one file
  // name would let array order decide whether membership is destroyed.
  const byFileName = new Map<string, MembershipRepairDecisionInput>();
  const duplicateDecisions = new Set<string>();
  for (const decision of decisions) {
    if (byFileName.has(decision.fileName)) duplicateDecisions.add(decision.fileName);
    byFileName.set(decision.fileName, decision);
  }
  for (const fileName of duplicateDecisions) byFileName.delete(fileName);

  // Resolved ONCE, before any removal. A lake-level fault - missing, or an id addressing nothing - is
  // invariant across the loop, so letting the per-member catch discover it issues one findById per
  // removal and returns a success-shaped outcome carrying N copies of one message.
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) throw new NotFoundError('Data lake not found');

  const removedFabFileIds: string[] = [];
  const groupsActedOn: MembershipRepairOutcome['groupsActedOn'] = [];
  const failures: MembershipRepairOutcome['failures'] = [];
  const staleDecisions: MembershipRepairOutcome['staleDecisions'] = [];
  const removedWithoutRestoreToken: string[] = [];
  let truncated = false;

  // Sequential, not a fan-out: every removal recomputes the lake's stats and can activate a draft
  // lake, so concurrent removals would race each other's recompute and persist a count from a
  // partial view. Bounded by MAX_MEMBERSHIP_REPAIR_REMOVALS rather than left to the route, so the
  // ceiling holds for every caller instead of only the one that remembers it.
  for (const group of [...plan.collapsible, ...plan.needsDecision]) {
    const { removals, stale } = removalsForGroup(group, byFileName);
    if (stale) staleDecisions.push(stale);
    if (removals.length === 0) continue;

    const removedHere: string[] = [];
    for (const fabFileId of removals) {
      if (removedFabFileIds.length >= MAX_MEMBERSHIP_REPAIR_REMOVALS) {
        truncated = true;
        break;
      }
      try {
        const { restoreTokenMinted } = await removeFileFromDataLake(actor, dataLakeId, fabFileId, adapters);
        removedHere.push(fabFileId);
        removedFabFileIds.push(fabFileId);
        if (!restoreTokenMinted) removedWithoutRestoreToken.push(fabFileId);
      } catch (err) {
        // Per-member catch: a repair that abandons the rest of the plan on one failure leaves the
        // lake in a state neither the owner nor the next plan can reason about. Recorded and
        // reported instead, so a re-run finishes the job and the caller can say what did not happen.
        failures.push({
          fabFileId,
          fileName: group.fileName,
          error: err instanceof Error ? err.message : String(err),
        });
        // Ids as fields and a static message, matching the sibling: a duplicate group is keyed by a
        // customer-uploaded file name, which is often identifying and does not belong in log text.
        logger?.warn?.('[dataLakes] membership repair could not remove a member', { dataLakeId, fabFileId, err });
      }
    }

    if (removedHere.length > 0) groupsActedOn.push({ fileName: group.fileName, removedFabFileIds: removedHere });
    if (truncated) break;
  }

  return {
    removedFabFileIds,
    groupsActedOn,
    failures,
    staleDecisions,
    duplicateDecisions: [...duplicateDecisions],
    removedWithoutRestoreToken,
    truncated,
  };
}
