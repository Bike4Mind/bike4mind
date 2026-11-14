import { organizationRepository } from '@bike4mind/database/infra';
import { isOrgOwnerOrCurrentAdmin } from '@bike4mind/common';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';

export async function assertLibraryAccess(
  actor: { id: string; isAdmin?: boolean },
  organizationId: string,
  manage = false
) {
  const organization = await organizationRepository.findById(organizationId);
  const membershipIds = await organizationRepository.findMembershipOrgIds(actor.id);
  if (!organization || !membershipIds.includes(organization.id)) throw new NotFoundError('Organization not found');
  if (manage && !isOrgOwnerOrCurrentAdmin(actor, organization)) {
    throw new ForbiddenError('Only organization admins can manage the library');
  }
  return organization;
}
