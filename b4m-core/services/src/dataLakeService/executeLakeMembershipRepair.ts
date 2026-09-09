import { NotFoundError } from '@bike4mind/common';
import {
  groupIdentity,
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
 * whether to touch a customer's membership is readable and testable in the pure module, and this one
 * only has to be right about HOW.
 *
 * WHAT A REMOVAL ACTUALLY DOES, stated precisely because an earlier draft of this comment
 * overclaimed. `removeFileFromDataLake` pulls this lake's meta-tag and its prefix-arm tags off the
 * FabFile. The file itself and its chunks survive. Its membership of OTHER lakes usually does too -
 * but not always, and the exception is this caller's to know: a lake sharing the prefix loses the
 * shared prefixed tag with it, and a lake that held the file by prefix alone loses the file
 * outright. That callee keeps the caveat deliberately ("narrow, not impossible"); this is the first
 * caller to apply the operation in BULK, which is what turns a narrow population into a likely one.
 * Each removal also mints a restore row and recomputes the lake's stats, which can flip a draft lake
 * to active - lake state, not membership.
 *
 * UNDO IS TIME-BOUNDED, and a caller must not promise otherwise. Recovery is re-adding, not
 * undeleting: `addFileToDataLake` takes the restore path only while the removal row lives, and that
 * row carries a 30-minute TTL and is written best-effort in a `catch` that only warns. Past it, a
 * re-add is refused for any file the lake's effective owner does not own - which includes the
 * ordinary case of an admin having added a stranger's file (see `contentTags` on lakeMembership).
 * Bulk makes this sharper than the single-file door it inherits it from: N removals share one expiry
 * window and undo is N separate calls. The outcome below deliberately does NOT claim which removals
 * are still undoable, because it cannot know - the callee swallows a failed restore write.
 *
 * NOT GATED HERE. The manage gate lives on the route, as it does for `planLakeConvergenceRun`, whose
 * route carries the authz. (`recordMembershipDecision` takes the same arrangement but explicitly
 * disclaims being a precedent to copy, so it is not cited as one.) A caller reaching this without
 * that gate is unauthorized and nothing here will say so.
 *
 * THE CONVERGENCE KILL SWITCH CANNOT HALT THIS, and a route must not assume it can. #2245 asks for
 * the operation to be gated on it, but `isConvergenceHalted` returns early unless the work is
 * `origin: 'convergence'`, and it resolves a pause flag over queued chunk work. A repair enqueues
 * nothing and is not convergence-origin, so that switch answers "not halted" for it every time.
 * Stamping a repair as convergence-origin to make it halt-able would be a lie about provenance. What
 * the route needs is a control this operation can actually be stopped by; naming which is a question
 * for the issue rather than something to invent here.
 */

/** Hard ceiling on removals in one run, mirroring `MAX_CONVERGENCE_WAVE` on the sibling this is modelled on. */
export const MAX_MEMBERSHIP_REPAIR_REMOVALS = 200;

/**
 * One owner ruling, as the route received it.
 *
 * `groupIdentity` is REQUIRED and is the whole point. A decision is about a group as the owner SAW
 * it; joining on file name alone applies it to whatever now carries that name. Concretely: an owner
 * rules `keep-newest` on `f.pdf` = [A(newest), B], a third copy C lands before the POST, a re-planning
 * route hands over [C, A, B], and "keep the newest" removes A and B - deleting the copy they elected
 * to keep and sparing one they never saw, reported as their decision.
 *
 * Modelled as a discriminated union so the impossible pairs are unrepresentable, matching
 * `MembershipDecisionInput` on the persistence side - the two are both on the barrel and a caller
 * should not find one accepting what the other rejects at runtime.
 */
export type MembershipRepairDecisionInput = {
  fileName: string;
  /** `groupIdentity` of the group the owner ruled on. A mismatch is reported, never applied. */
  groupIdentity: string;
} & (
  | { decision: 'keep-specific'; keptFabFileId: string }
  | { decision: Exclude<RepairDecision, 'keep-specific'>; keptFabFileId?: null }
);

/** Why a supplied decision was not applied. Never silent - the information dies here otherwise. */
export type IgnoredDecisionReason = 'duplicate-file-name' | 'no-matching-group' | 'group-changed-since-decision';

export interface MembershipRepairOutcome {
  /** Members whose lake membership was removed, in removal order. */
  removedFabFileIds: string[];
  /** Per group, so a surface can attribute and offer undo per file rather than only a total. */
  groupsActedOn: { fileName: string; removedFabFileIds: string[] }[];
  /**
   * Removals attempted that threw. One member failing must not abandon the rest - a half-applied
   * repair the owner can re-run is recoverable; an abandoned one silently is not.
   */
  failures: { fabFileId: string; fileName: string; error: string }[];
  /**
   * Decisions that changed nothing, and why. Without this a stale ruling, a duplicate, and a
   * typo'd name all produce an identical empty outcome, and no endpoint can reconstruct the
   * difference later because the information is destroyed here.
   */
  ignoredDecisions: { fileName: string; reason: IgnoredDecisionReason }[];
  /** True when the run stopped at MAX_MEMBERSHIP_REPAIR_REMOVALS with work still outstanding. */
  truncated: boolean;
}

/**
 * Index decisions by file name, reporting rather than silently resolving the ambiguous ones.
 *
 * Last-wins on a duplicate file name would make a destructive outcome depend on array position:
 * `[keep-both, keep-newest]` removes members and the reverse removes none. Neither is defensible, so
 * a duplicated name applies NOTHING and says so.
 */
function indexDecisions(decisions: MembershipRepairDecisionInput[]): {
  byFileName: Map<string, MembershipRepairDecisionInput>;
  ignored: MembershipRepairOutcome['ignoredDecisions'];
} {
  const byFileName = new Map<string, MembershipRepairDecisionInput>();
  const duplicated = new Set<string>();
  for (const decision of decisions) {
    if (byFileName.has(decision.fileName)) duplicated.add(decision.fileName);
    byFileName.set(decision.fileName, decision);
  }
  for (const fileName of duplicated) byFileName.delete(fileName);
  return {
    byFileName,
    ignored: [...duplicated].map(fileName => ({ fileName, reason: 'duplicate-file-name' as const })),
  };
}

/**
 * Which members a group loses in this run.
 *
 * The plan's own `removeFabFileIds` is the ONLY source for the automatic arm - it is empty on every
 * `decide` group by construction (see `planMembershipRepair`), so an executor that read it for every
 * group in the plan would still be correct. A supplied decision is what turns a `decide` group into
 * removals, and only when its identity still matches the group in front of it.
 */
function removalsForGroup(
  group: PlannedRepairGroup,
  byFileName: Map<string, MembershipRepairDecisionInput>
): { removals: string[]; ignored?: IgnoredDecisionReason } {
  if (group.action === 'collapse') return { removals: group.removeFabFileIds };
  const decision = byFileName.get(group.fileName);
  if (!decision) return { removals: [] };
  // Recomputed from the group rather than read off `group.groupIdentity`, so this cannot be fooled
  // by a plan whose stamped identity disagrees with the members it carries.
  if (decision.groupIdentity !== groupIdentity(group)) {
    return { removals: [], ignored: 'group-changed-since-decision' };
  }
  return { removals: membersRemovedByDecision(group, decision.decision, decision.keptFabFileId) };
}

/**
 * Execute a repair plan: the automatic arm always, plus whatever the owner decided.
 *
 * With no decisions supplied this removes bucket A only and leaves B and C untouched - not by a rule
 * this function remembers, but because the plan's `decide` groups carry an empty `removeFabFileIds`
 * and no decision resolves to anything.
 *
 * `settled` groups are never acted on. They carry a prior decision that already suppressed them, and
 * their `outstandingRemovalFabFileIds` is a SIGNAL about work never carried out, not an instruction -
 * acting on it would let a stale tombstone remove membership with no owner in the loop.
 */
export async function executeLakeMembershipRepair(
  actor: MembershipActor,
  dataLakeId: string,
  plan: MembershipRepairPlan,
  decisions: MembershipRepairDecisionInput[],
  adapters: RemoveFileFromDataLakeAdapters
): Promise<MembershipRepairOutcome> {
  const { db, logger } = adapters;
  const { byFileName, ignored } = indexDecisions(decisions);

  // Resolved ONCE, before any removal. Lake-level faults - missing, or an id that addresses nothing -
  // are invariant across the loop, so letting the per-member catch discover them issues one findById
  // per removal and returns a success-shaped outcome carrying N copies of one message.
  const lake = await db.dataLakes.findById(dataLakeId);
  if (!lake) throw new NotFoundError('Data lake not found');

  const removedFabFileIds: string[] = [];
  const groupsActedOn: MembershipRepairOutcome['groupsActedOn'] = [];
  const failures: MembershipRepairOutcome['failures'] = [];
  const ignoredDecisions = [...ignored];
  const matchedFileNames = new Set<string>();
  let truncated = false;

  // Sequential over groups AND members, not a fan-out at either level. Every removal recomputes the
  // lake's stats and can activate a draft lake, so two in flight race each other's recompute and
  // persist a count from a partial view.
  for (const group of [...plan.collapsible, ...plan.needsDecision]) {
    if (byFileName.has(group.fileName)) matchedFileNames.add(group.fileName);
    const { removals, ignored: ignoredReason } = removalsForGroup(group, byFileName);
    if (ignoredReason) ignoredDecisions.push({ fileName: group.fileName, reason: ignoredReason });
    if (removals.length === 0) continue;

    const removedHere: string[] = [];
    for (const fabFileId of removals) {
      if (removedFabFileIds.length >= MAX_MEMBERSHIP_REPAIR_REMOVALS) {
        truncated = true;
        break;
      }
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
        // File name kept OUT of the message and passed as a field: it is customer-uploaded and often
        // identifying, and the sibling in this call chain keeps its message static for that reason.
        logger?.warn?.('[dataLakes] membership repair could not remove a member', {
          dataLakeId,
          fabFileId,
          fileName: group.fileName,
          err,
        });
      }
    }

    // `removedHere`, never the run-wide list: with the latter every group after the first reports
    // its predecessors' ids, and a per-file undo would target the wrong files.
    if (removedHere.length > 0) groupsActedOn.push({ fileName: group.fileName, removedFabFileIds: removedHere });
    if (truncated) break;
  }

  for (const fileName of byFileName.keys()) {
    if (!matchedFileNames.has(fileName)) ignoredDecisions.push({ fileName, reason: 'no-matching-group' });
  }

  return { removedFabFileIds, groupsActedOn, failures, ignoredDecisions, truncated };
}
