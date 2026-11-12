import type { IOrganizationDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database/infra';
import { ForbiddenError, NotFoundError } from '@bike4mind/utils';

export const ORGANIZATION_MFA_REQUIRED = 'Organization requires MFA. Set up MFA in account security to continue.';

export function organizationMfaIsEnforced(policy: IOrganizationDocument['mfaPolicy'], now = Date.now()): boolean {
  if (!policy?.required) return false;
  const deadline = policy.enforceAfter == null ? NaN : new Date(policy.enforceAfter).getTime();
  return !Number.isFinite(deadline) || deadline <= now;
}

export async function assertOrganizationMfa(
  userId: string,
  organizationId: string,
  authorizedOrganization?: Pick<IOrganizationDocument, 'mfaPolicy'>
): Promise<void> {
  const organization = authorizedOrganization ?? (await organizationRepository.findById(organizationId));
  if (!organization) throw new NotFoundError('Organization not found');
  if (!organizationMfaIsEnforced(organization.mfaPolicy)) return;
  const { mfaService } = await import('@bike4mind/services');
  const { userRepository } = await import('@bike4mind/database/auth');
  const user = await userRepository.findById(userId);
  if (!user || !mfaService.userHasMFAConfigured(user)) {
    throw new ForbiddenError(ORGANIZATION_MFA_REQUIRED);
  }
}
