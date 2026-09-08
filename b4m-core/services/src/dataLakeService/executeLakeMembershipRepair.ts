import { membersRemovedByDecision, type MembershipRepairPlan, type PlannedRepairGroup } from '@bike4mind/common';
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
 * Removal is membership only - `removeFileFromDataLake` pulls the lake's tags off the FabFile. The
 * file, its chunks, and its membership of any other lake are untouched, which is what makes the
 * operation recoverable and is asserted rather than assumed (see the tests).
 *
 * NOT gated here. Like `recordMembershipDecision`, the manage gate and the convergence kill switch
 * live on the route - the same arrangement `converge` uses, where the service plans and the handler
 * decides whether it may run. A caller reaching this without those is unauthorized and nothing here
 * will say so.
 */

/** What the caller asked to happen beyond the plan's automatic arm, keyed by file name. */
export interface MembershipRepairDecisionInput {
  fileName: string;
  decision: Parameters<typeof membersRemovedByDecision>[1];
  keptFabFileId?: string | null;
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
}

/**
 * Which members a group loses in this run.
 *
 * The plan's own `removeFabFileIds` is the ONLY source for the automatic arm - it is empty on every
 * `decide` group by construction (see `planMembershipRepair`), so an executor that read it for every
 * group in the plan would still be correct. A supplied decision is what turns a `decide` group into
 * removals, and it is resolved against the group as the PLAN saw it, not re-derived: the plan is the
 * thing the owner reviewed.
 */
function removalsForGroup(group: PlannedRepairGroup, byFileName: Map<string, MembershipRepairDecisionInput>): string[] {
  if (group.action === 'collapse') return group.removeFabFileIds;
  const decision = byFileName.get(group.fileName);
  if (!decision) return [];
  return membersRemovedByDecision(group, decision.decision, decision.keptFabFileId);
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
  const { logger } = adapters;
  const byFileName = new Map(decisions.map(d => [d.fileName, d]));

  const removedFabFileIds: string[] = [];
  const groupsActedOn: MembershipRepairOutcome['groupsActedOn'] = [];
  const failures: MembershipRepairOutcome['failures'] = [];

  // Sequential, not a fan-out: every removal recomputes the lake's stats and can activate a draft
  // lake, so concurrent removals would race each other's recompute and persist a count from a
  // partial view. The wave is bounded by the plan's own caps, so there is nothing to gain.
  for (const group of [...plan.collapsible, ...plan.needsDecision]) {
    const removals = removalsForGroup(group, byFileName);
    if (removals.length === 0) continue;

    const removedHere: string[] = [];
    for (const fabFileId of removals) {
      try {
        await removeFileFromDataLake(actor, dataLakeId, fabFileId, adapters);
        removedHere.push(fabFileId);
        removedFabFileIds.push(fabFileId);
      } catch (err) {
        // Per-member catch: a repair that abandons the rest of the plan on one failure leaves the
        // lake in a state neither the owner nor the next plan can reason about. Recorded and
        // reported instead, so a re-run finishes the job and the caller can say what did not happen.
        failures.push({
          fabFileId,
          fileName: group.fileName,
          error: err instanceof Error ? err.message : String(err),
        });
        logger?.warn?.(
          `[membershipRepair] lake ${dataLakeId}: removing ${fabFileId} from '${group.fileName}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    if (removedHere.length > 0) groupsActedOn.push({ fileName: group.fileName, removedFabFileIds: removedHere });
  }

  return { removedFabFileIds, groupsActedOn, failures };
}
