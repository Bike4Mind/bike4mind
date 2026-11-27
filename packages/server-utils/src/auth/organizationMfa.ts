import type { IUserDocument } from '@bike4mind/common';
import { Organization, organizationRepository } from '@bike4mind/database/infra';

export async function requiresOrganizationMfaEnrollment(user: IUserDocument, now = new Date()): Promise<boolean> {
  if (user.serviceAccountOrganizationId) return false;
  const organizationIds = await organizationRepository.findMembershipOrgIds(user.id);
  if (organizationIds.length === 0) return false;
  return !!(await Organization.exists({
    _id: { $in: organizationIds },
    personal: false,
    'mfaPolicy.required': true,
    'mfaPolicy.graceEndsAt': { $ne: null, $lte: now },
  }));
}
