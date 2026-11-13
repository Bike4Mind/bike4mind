import { IGroupRepository, IOrganizationRepository, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { assertCanManageOrgGroups } from './groupMembership';

export async function shareGroupProject(
  actingUser: IUserDocument,
  {
    organizationId,
    groupId,
    projectId,
    enabled,
  }: {
    organizationId: string;
    groupId: string;
    projectId: string;
    enabled: boolean;
  },
  {
    db,
  }: {
    db: {
      organizations: Pick<IOrganizationRepository, 'findById'>;
      groups: Pick<IGroupRepository, 'findById'>;
      projects: Pick<IProjectRepository, 'setOwnedGroupReadAccess'>;
    };
  }
) {
  const organization = await db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  assertCanManageOrgGroups(actingUser, organization);
  const group = await db.groups.findById(groupId);
  if (!group || group.organizationId !== organizationId) throw new NotFoundError('Group not found');
  if (!(await db.projects.setOwnedGroupReadAccess(projectId, actingUser.id, groupId, enabled))) {
    throw new NotFoundError('Owned project not found');
  }
}
