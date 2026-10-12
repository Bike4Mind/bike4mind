import type { IUserDocument } from '@bike4mind/common';
import { organizationRepository, Project, readAccessArms } from '@bike4mind/database';

/**
 * Ids of every user who shares an organization or a project with `user` (`user` included).
 * This is the scope of the non-admin member picker on GET /api/users: org membership reuses
 * organizationRepository.findMembershipOrgIds/findMemberUserIds so the picker agrees with every
 * other "is X in this org?" answer, and project membership is the owner plus users[] of each
 * project the same readAccessArms predicate as the by-id project read admits.
 */
export async function findSharedWorkspaceUserIds(user: Pick<IUserDocument, 'id' | 'groups'>): Promise<Set<string>> {
  const [orgIds, projects] = await Promise.all([
    organizationRepository.findMembershipOrgIds(user.id),
    Project.find({ $or: readAccessArms(user), deletedAt: null }, { userId: 1, users: 1 }).lean(),
  ]);
  const orgMembers = await Promise.all(orgIds.map(orgId => organizationRepository.findMemberUserIds(orgId)));

  const ids = new Set<string>([user.id]);
  for (const { userIds } of orgMembers) userIds.forEach(id => ids.add(id));
  for (const project of projects) {
    ids.add(String(project.userId));
    (project.users ?? []).forEach(member => ids.add(String(member.userId)));
  }
  return ids;
}
