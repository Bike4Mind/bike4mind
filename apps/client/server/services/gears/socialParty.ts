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

const PROJECT_BATCH = 100;

type ProjectMembers = { _id: unknown; users?: Array<{ userId?: unknown; permissions?: string[] }> };

/**
 * hasQualifyingSocialParty over the read-access members of every live project `ownerId` owns,
 * walked in _id order PROJECT_BATCH projects at a time and stopping at the first qualifying member.
 */
export async function hasQualifyingProjectCollaborator(ownerId: string): Promise<boolean> {
  let after: unknown;
  for (;;) {
    const projects = await Project.find(
      {
        userId: ownerId,
        deletedAt: null,
        'users.permissions': 'read',
        ...(after === undefined ? {} : { _id: { $gt: after } }),
      },
      { 'users.userId': 1, 'users.permissions': 1 }
    )
      .sort({ _id: 1 })
      .limit(PROJECT_BATCH)
      .lean<ProjectMembers[]>();
    const memberIds = projects.flatMap(project =>
      (project.users ?? []).filter(member => member.permissions?.includes('read')).map(member => String(member.userId))
    );
    if (await hasQualifyingSocialParty(ownerId, memberIds)) return true;
    if (projects.length < PROJECT_BATCH) return false;
    after = projects[projects.length - 1]._id;
  }
}
