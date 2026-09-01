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

export interface MembershipDecisionInput {
  decision: RepairDecision;
  /** Required for `keep-specific`, rejected for the others - see the validation note below. */
  keptFabFileId?: string | null;
  source: LakeMembershipDecisionSource;
}

/**
 * Persist one owner ruling about one duplicated file name, stamped with the identity of the group
 * as it stands RIGHT NOW.
 *
 * Stamping here rather than trusting a caller-supplied `groupIdentity` is the point of the function.
 * The identity is what decides whether the ruling still applies on the next run, so a client that
 * computed it from a plan it fetched ten minutes ago would pin the decision to a group that has
 * since gained a third copy - and the owner's "keep both", made about two files, would silently
 * suppress a question about three. Recomputing from the live group means a ruling made against
 * stale state is stamped against current state, and the next material change re-opens it honestly.
 *
 * Authorization is NOT here: the manage gate lives on the route, the same split the rest of
 * dataLakeService uses. `actorUserId` is recorded for audit only.
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
  if (input.decision === 'keep-specific') {
    if (!input.keptFabFileId) {
      throw new BadRequestError('keep-specific requires the member to keep');
    }
    if (!group.members.some(m => m.fabFileId === input.keptFabFileId)) {
      throw new BadRequestError('The member to keep is not part of this duplicate group');
    }
  } else if (input.keptFabFileId) {
    throw new BadRequestError(`keptFabFileId is only meaningful for keep-specific, not ${input.decision}`);
  }

  return db.lakeMembershipDecisions.upsertDecision({
    dataLakeId,
    fileName: group.fileName,
    decision: input.decision,
    keptFabFileId: input.decision === 'keep-specific' ? (input.keptFabFileId ?? null) : null,
    groupIdentity: groupIdentity(group),
    decidedByUserId: actorUserId,
    decidedAt: new Date(),
    source: input.source,
  });
}
