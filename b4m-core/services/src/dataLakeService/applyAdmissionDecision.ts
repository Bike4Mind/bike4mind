import type {
  DuplicateGroup,
  IDataLakeDocument,
  IFabFileRepository,
  ILakeMembershipDecisionRepository,
  RepairDecision,
} from '@bike4mind/common';
import { DECIDABLE_GROUP_MEMBERS, buildDuplicateGroups, membersRemovedByDecision } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { lakeMembershipScope } from './lakeMembershipScope';
import { recordMembershipDecision } from './recordMembershipDecision';
import { removeFileFromDataLake } from './removeFileFromDataLake';
import type { MembershipActor } from './lakeMembership';

/**
 * Carry out one owner ruling about one duplicated name in one lake - the answering half of the
 * same-identity admission check (#2238), whose detecting half is `detectAdmissionDuplicates`.
 *
 * Two things happen, in this order, and the order is the point:
 *
 *  1. The ruling is RECORDED (`source: 'admission'`), stamped over the group as it stands right now.
 *  2. Whatever the ruling removes is removed, through the ordinary lake-scoped removal door.
 *
 * Record-then-remove, because the reverse leaves the worse failure. A removal that lands with no
 * ruling on record re-opens the same question on the next repair run, about a pair the owner already
 * settled - the exact re-ask the tombstone exists to prevent. A ruling on record whose removal
 * failed is visible instead: the plan reports it as `outstandingRemovalFabFileIds`, which is what
 * that field is for.
 *
 * "Keep newest" is a real product operation here rather than a note in a report, and that is the
 * durable fix this issue is about: the duplicated corpus that motivated the whole lane was created
 * by an external script attempting exactly this and getting it wrong silently, because there was no
 * supported way to replace a lake member. Removal goes through `removeFileFromDataLake` and not
 * through a bespoke write, so a replacement is lake-scoped (the file survives in its owner's Files
 * list and in every other lake) and mints the same short-TTL restore record every other removal
 * does - the owner gets Undo on a replacement for free.
 *
 * `groupIdentity` staleness after a removal is not a gap: `keep-newest`/`keep-specific` leave one
 * member behind, and a name held by one member is not a group at all, so there is nothing left for
 * the plan to re-ask about. `keep-both` removes nothing, so its identity - and its tombstone - hold.
 *
 * Authorization is the CALLER's. The route holds the manage gate, the same arrangement
 * `recordMembershipDecision` documents; nothing here will refuse an unauthorized actor.
 */

/**
 * Discriminated the same way `MembershipDecisionInput` is, and for the same reason: a
 * `keep-specific` with no member, and a `keep-newest` carrying one, are both unrepresentable. The
 * runtime pairing check still lives in `recordMembershipDecision` and on the schema - this type does
 * nothing for a body parsed off the wire - so the route's own validator is what actually rejects it.
 */
export type ApplyAdmissionDecisionInput = {
  /** The duplicated name the ruling is about. Matches `DuplicateGroup.fileName`. */
  fileName: string;
} & (
  | { decision: 'keep-specific'; keptFabFileId: string }
  | { decision: Exclude<RepairDecision, 'keep-specific'>; keptFabFileId?: null }
);

export type ApplyAdmissionDecisionAdapters = Parameters<typeof removeFileFromDataLake>[3] & {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findLakeMemberSiblingsByFileName'>;
    lakeMembershipDecisions: Pick<ILakeMembershipDecisionRepository, 'upsertDecision'>;
  };
};

export interface ApplyAdmissionDecisionResult {
  /** The group the ruling was stamped over, as it stood BEFORE any removal. */
  group: DuplicateGroup;
  /** Members actually removed from the lake. Empty for `keep-both`. */
  removedFabFileIds: string[];
}

export async function applyAdmissionDecision(
  actor: MembershipActor,
  lake: Pick<IDataLakeDocument, 'id' | 'datalakeTag' | 'fileTagPrefix' | 'createdByUserId'>,
  input: ApplyAdmissionDecisionInput,
  adapters: ApplyAdmissionDecisionAdapters
): Promise<ApplyAdmissionDecisionResult> {
  const { db } = adapters;

  // Read FRESH, and read it here rather than taking a group from the caller: `groupIdentity` decides
  // whether the ruling still applies on the next run, so a client-supplied group fetched minutes ago
  // would pin the decision to a set that has since gained a third copy - and a "keep both" made
  // about two files would silently suppress a question about three. `recordMembershipDecision` names
  // this as its caller's obligation; this is the caller that owes it.
  //
  // No `excludeFabFileId`: a ruling is stamped over EVERY member of the group. And the bound is
  // passed EXPLICITLY, because omitting the exclusion does not omit the limit - the repository
  // default (50) is narrower than what the repair-plan read offers, and a ruling stamped over 50 of
  // a name's 120 members can never match the identity that door recomputes over the 200 it built.
  // See `DECIDABLE_GROUP_MEMBERS` for what each side of that mismatch breaks.
  const members = await db.fabFiles.findLakeMemberSiblingsByFileName(
    lakeMembershipScope(lake),
    input.fileName,
    null,
    DECIDABLE_GROUP_MEMBERS
  );
  const { groups } = buildDuplicateGroups(members);
  // At most one group per name, by construction - see buildDuplicateGroups.
  const group = groups.find(g => g.fileName === input.fileName);
  if (!group) {
    // Not-found rather than a silent no-op: the name may have held a group when the offer was made
    // and not now (a concurrent removal, a re-chunk that moved a member's identity), and a caller
    // told "ok" would show the owner a decision that governs nothing.
    throw new NotFoundError('That file name no longer has duplicate members in this data lake');
  }

  const { fileName: _name, ...ruling } = input;
  await recordMembershipDecision(actor.userId, lake.id, group, { ...ruling, source: 'admission' }, { db });

  const removeFabFileIds = membersRemovedByDecision(group, input.decision, input.keptFabFileId);
  const removedFabFileIds: string[] = [];
  // Sequential, not concurrent: each removal recomputes the lake's stats, and two of those racing
  // would have one overwrite the other's count. Slow only in the number of copies of ONE name.
  for (const fabFileId of removeFabFileIds) {
    await removeFileFromDataLake(actor, lake.id, fabFileId, adapters);
    removedFabFileIds.push(fabFileId);
  }

  return { group, removedFabFileIds };
}
