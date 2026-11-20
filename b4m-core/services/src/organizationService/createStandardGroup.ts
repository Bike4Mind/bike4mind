import { getGroupType, IUserDocument } from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';
import { assertCanManageOrgGroups } from './groupMembership';
import { setOrganizationGroupTypes } from './setOrganizationGroupTypes';

export async function createStandardGroup(
  actingUser: IUserDocument,
  { organizationId, type }: { organizationId: string; type: string },
  adapters: Parameters<typeof setOrganizationGroupTypes>[1]
) {
  const organization = await adapters.db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  assertCanManageOrgGroups(actingUser, organization);
  if (organization.personal) throw new BadRequestError('Personal organizations cannot have groups');
  if (!getGroupType(type)?.selfServe) throw new ForbiddenError('This group type requires platform staff approval');

  return setOrganizationGroupTypes(
    { organizationId, allowedGroupTypes: [...new Set([...(organization.allowedGroupTypes ?? []), type])] },
    adapters
  );
}
