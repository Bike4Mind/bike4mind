import type {
  DuplicateGroup,
  ILakeMembershipDecisionDocument,
  ILakeMembershipDecisionRepository,
  LakeMembershipDecisionSource,
  RepairDecision,
} from '@bike4mind/common';
import { groupIdentity } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

interface RecordMembershipDecisionAdapters {
  db: {
    lakeMembershipDecisions: Pick<ILakeMembershipDecisionRepository, 'upsertDecision'>;
  };
}

/**
 * Discriminated on `decision` so the two fields cannot vary independently: a `keep-specific` with no
 * member, and a `keep-newest` carrying one, are both unrepresentable. The runtime checks below stay
 * regardless - this type does nothing for a body parsed off the wire - and the same pairing is
 * enforced again at the schema, which is the layer every writer shares.
 */
export type MembershipDecisionInput = { source: LakeMembershipDecisionSource } & (
  | { decision: 'keep-specific'; keptFabFileId: string }
  | { decision: Exclude<RepairDecision, 'keep-specific'>; keptFabFileId?: null }
);

/**
 * Persist one owner ruling about one duplicated file name, stamped with the identity of the group
 * as it stands RIGHT NOW.
 *
 * Stamping here rather than trusting a caller-supplied `groupIdentity` is the point of the function.
 * The identity is what decides whether the ruling still applies on the next run, so a client that
 * sent one it computed from a plan fetched ten minutes ago would pin the decision to a group that
 * has since gained a third copy - and the owner's "keep both", made about two files, would silently
 * suppress a question about three.
 *
 * CALLER OWES A FRESHLY-READ GROUP. This function does not read one: `group` is a parameter, so the
 * identity is recomputed from whatever the caller passed, not from the database. Passing the same
 * ten-minute-old group reintroduces exactly the staleness above - it is moved one frame up the
 * stack, not defeated. Closing it here would mean taking a repository and re-deriving the group,
 * which the surface that will call this does not exist yet to need; until then this is the caller's
 * obligation and is stated rather than implied.
 *
 * Authorization is NOT here: the manage gate lives on the route, and `actorUserId` is recorded for
 * audit only. That is this function's arrangement, not a house convention to copy - dataLakeService
 * does it both ways, and plenty of its services take an AccessContext and gate internally instead. A
 * caller reaching this one without the route's gate is unauthorized and nothing here will say so.
 */
export async function recordMembershipDecision(
  actorUserId: string,
  dataLakeId: string,
  group: Pick<DuplicateGroup, 'fileName' | 'members'>,
  input: MembershipDecisionInput,
  { db }: RecordMembershipDecisionAdapters
): Promise<ILakeMembershipDecisionDocument> {
  // A `keep-specific` naming a member that is not in the group is rejected rather than coerced.
  // `membersRemovedByDecision` already degrades a stale kept-id to "remove nothing", which is the
  // right read-time posture; at WRITE time the same input is a client bug or a raced group, and
  // storing it would persist a ruling that quietly removes nothing forever while reading as a
  // decision the owner made.
  //
  // Read through a widened view deliberately: `MembershipDecisionInput` makes the mismatched pairs
  // unrepresentable, so narrowing would prove these branches dead and TS would type the second one
  // `never`. They are not dead - the caller is a route handing over a parsed body, where the type is
  // an assertion about what SHOULD arrive, not a fact about what did.
  const { decision, keptFabFileId } = input as { decision: RepairDecision; keptFabFileId?: string | null };
  if (decision === 'keep-specific') {
    if (!keptFabFileId) {
      throw new BadRequestError('keep-specific requires the member to keep');
    }
    if (!group.members.some(m => m.fabFileId === keptFabFileId)) {
      throw new BadRequestError('The member to keep is not part of this duplicate group');
    }
  } else if (keptFabFileId) {
    throw new BadRequestError(`keptFabFileId is only meaningful for keep-specific, not ${decision}`);
  }

  return db.lakeMembershipDecisions.upsertDecision({
    dataLakeId,
    fileName: group.fileName,
    decision,
    keptFabFileId: decision === 'keep-specific' ? (keptFabFileId ?? null) : null,
    groupIdentity: groupIdentity(group),
    decidedByUserId: actorUserId,
    decidedAt: new Date(),
    source: input.source,
  });
}
