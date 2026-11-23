import { Project, User } from '@bike4mind/database';
import { creditService } from '@bike4mind/services';

type PartyRow = creditService.RewardPartyFields & {
  _id: unknown;
  emailVerified?: boolean;
  signupMeta?: { ip?: string | null } | null;
};

const PARTY_PROJECTION = {
  emailVerified: 1,
  isBanned: 1,
  disputePending: 1,
  moderation: 1,
  deletedAt: 1,
  isSynthetic: 1,
  'signupMeta.ip': 1,
};

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * True when one of `partyIds` is an account other than `beneficiaryId` with a verified email, no
 * reward-party block (creditService.isRewardPartyBlocked), and a signup IP different from the
 * beneficiary's. The social gears (Team Up, Published) pay only on such a collaborator or viewer.
 */
export async function hasQualifyingSocialParty(beneficiaryId: string, partyIds: string[]): Promise<boolean> {
  const others = [...new Set(partyIds.map(String))].filter(id => id !== beneficiaryId && OBJECT_ID_RE.test(id));
  if (others.length === 0) return false;
  const ids = OBJECT_ID_RE.test(beneficiaryId) ? [beneficiaryId, ...others] : others;
  const rows = await User.find({ _id: { $in: ids } }, PARTY_PROJECTION).lean<PartyRow[]>();
  const beneficiaryIp = rows.find(row => String(row._id) === beneficiaryId)?.signupMeta?.ip ?? null;
  return rows.some(
    row =>
      String(row._id) !== beneficiaryId &&
      row.emailVerified === true &&
      !creditService.isRewardPartyBlocked(row) &&
      (!beneficiaryIp || row.signupMeta?.ip !== beneficiaryIp)
  );
}

/** hasQualifyingSocialParty over the collaborators of the projects `ownerId` owns. */
export async function hasQualifyingProjectCollaborator(ownerId: string): Promise<boolean> {
  const projects = await Project.find(
    { userId: ownerId, deletedAt: null, 'users.0': { $exists: true } },
    { 'users.userId': 1 }
  )
    .limit(100)
    .lean<Array<{ users?: Array<{ userId?: unknown }> }>>();
  return hasQualifyingSocialParty(
    ownerId,
    projects.flatMap(project => (project.users ?? []).map(member => String(member.userId)))
  );
}
