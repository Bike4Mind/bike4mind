import {
  DECIDABLE_GROUP_MEMBERS,
  planMembershipRepair,
  summarizeLakeMembership,
  toWireDuplicateGroup,
  type IDataLakeDocument,
  type IFabFileRepository,
  type ILakeMembershipDecisionRepository,
  type MembershipRepairPlanRead,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { MEMBER_SCAN_LIMIT, membershipScopeDisclosure } from './computeLakeHealth';
import { lakeMembershipScope } from './lakeMembershipScope';

/**
 * Which duplicate groups a lake's manager still has to answer (#2238).
 *
 * The read half of the duplicate decision door: POST /api/data-lakes/:id/membership-decisions is
 * where an answer lands, and this is what the surface offering the question reads. It exists as its
 * own door rather than as a field on GET .../health because the health report is deliberately
 * ruling-BLIND - it describes what is in the lake, and it is readable by anyone who can read the
 * lake, including `public`. "What is still unanswered" is a manager's view of the same facts.
 *
 * A ruling on record is what makes an answered group stop being offered. Without that suppression
 * `keep-both` - the one decision whose entire purpose is "stop asking me" - would be recorded and
 * then re-asked on the next render, since keeping both copies leaves the group intact and therefore
 * still a duplicate. `keep-newest` and `keep-specific` clear themselves by shrinking the group, so
 * this door matters most for exactly the answer the raw report cannot represent.
 *
 * Classification is `planMembershipRepair`'s, called whole rather than re-derived: it already knows
 * that a ruling only settles a group while its `groupIdentity` still matches (so a replaced copy
 * re-opens the question), that a group anyone has ever ruled on must never fall to the automatic
 * arm, and how to tie-break two rulings filed under one name. A second implementation of those rules
 * is how one door suppresses a group the other still offers.
 */

export interface LoadMembershipRepairPlanAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findDataLakeMembershipMembers'>;
    lakeMembershipDecisions: Pick<ILakeMembershipDecisionRepository, 'listByLake'>;
  };
  logger?: Pick<Logger, 'warn'>;
}

/** How many open groups reach the wire. `openGroupCount` stays exact. */
const OPEN_GROUPS_RETURNED = 50;

export async function loadMembershipRepairPlan(
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  { db, logger }: LoadMembershipRepairPlanAdapters
): Promise<MembershipRepairPlanRead> {
  const scope = lakeMembershipScope(lake);
  const rows = await db.fabFiles.findDataLakeMembershipMembers(scope, MEMBER_SCAN_LIMIT);
  const truncated = rows.length > MEMBER_SCAN_LIMIT;
  if (truncated) {
    logger?.warn?.(
      `[membershipRepair] lake ${lake.id} exceeds ${MEMBER_SCAN_LIMIT} members; open duplicate groups ` +
        `computed over the OLDEST ${MEMBER_SCAN_LIMIT} (the scan is _id-ascending), so the count is a ` +
        `lower bound - see scanTruncated.`
    );
  }

  // Deliberately UNCAPPED at the group level, unlike the health report: the settled/open split has to
  // see every group. Capping first would let a lake whose worst-first head is entirely settled hide
  // its open groups behind the cap - the cap is applied to `open` below instead, where it bounds the
  // payload without deciding what is in it.
  // `DECIDABLE_GROUP_MEMBERS`, not the health report's payload cap: the groups this door builds are
  // what `planMembershipRepair` recomputes a `groupIdentity` over, so this number has to be the one
  // the decision door reads its members by. See the constant.
  const report = summarizeLakeMembership(truncated ? rows.slice(0, MEMBER_SCAN_LIMIT) : rows, {
    scope: membershipScopeDisclosure(scope),
    scanTruncated: truncated,
    maxGroupMembers: DECIDABLE_GROUP_MEMBERS,
  });
  if (report.duplicateGroups.length === 0) {
    return {
      open: [],
      openGroupCount: 0,
      settledGroupCount: 0,
      stalledGroupCount: 0,
      scope: report.scope,
      scanTruncated: truncated,
    };
  }

  // `listByLake` is what satisfies both of planMembershipRepair's preconditions: one lake's records
  // only, and at most one per file name (the collection holds a unique index on the pair).
  const decisions = await db.lakeMembershipDecisions.listByLake(lake.id);
  const plan = planMembershipRepair(report.duplicateGroups, decisions);

  // A ruling that was written but whose removal never happened does NOT settle its group here, even
  // though the plan classifies it as settled - the plan's job is to say a human has ruled, this
  // door's job is to say whether the lake reflects it.
  const stalled = plan.settled.filter(group => (group.outstandingRemovalFabFileIds ?? []).length > 0);
  const answered = new Set(
    plan.settled.filter(group => (group.outstandingRemovalFabFileIds ?? []).length === 0).map(g => g.fileName)
  );

  // Filtered out of the REPORT's groups rather than rebuilt from the plan's, because a
  // `PlannedRepairGroup` drops `memberCount` and `tier` - the two things a surface needs to say how
  // many copies there are and how confidently they were matched. Order is the report's worst-first.
  const open = report.duplicateGroups.filter(group => !answered.has(group.fileName));

  return {
    open: open.slice(0, OPEN_GROUPS_RETURNED).map(toWireDuplicateGroup),
    openGroupCount: open.length,
    settledGroupCount: answered.size,
    stalledGroupCount: stalled.length,
    scope: report.scope,
    scanTruncated: truncated,
  };
}
