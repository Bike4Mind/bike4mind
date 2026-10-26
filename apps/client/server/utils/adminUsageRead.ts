import { hasAdminPermission } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database/infra';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';

type UsageReader = { id: string; isAdmin?: boolean; adminPermissions?: readonly string[] | null };

// Read-only authorization for the two billing views also used by ordinary organization owners.
export async function verifyOrgUsageRead(user: UsageReader, organizationId: string) {
  if (!isValidObjectId(organizationId)) throw new BadRequestError('Invalid organization ID');
  const organization = await organizationRepository.findById(organizationId);
  if (!organization || (!hasAdminPermission(user, 'support:read') && String(organization.userId) !== String(user.id))) {
    throw new NotFoundError('Organization not found');
  }
  return organization;
}
