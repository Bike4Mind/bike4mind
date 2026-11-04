import { grantPackageRepository, organizationRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

/**
 * Guard for the admin partner-signup-rule routes: a rule may only reference an org that
 * exists. Zod validates the id SHAPE; this is the DB existence check it can't do. A `null`
 * id (clearing the association) is always allowed. Shared by create, update, and backfill so
 * the check can't drift between them.
 */
export async function assertOrganizationExists(organizationId: string | null | undefined): Promise<void> {
  if (!organizationId) return;
  const organization = await organizationRepository.findById(organizationId);
  if (!organization) {
    throw new BadRequestError(`Organization ${organizationId} not found`);
  }
}

/**
 * Same guard for a rule's grant package. A `null` id (unlinking the package) is always allowed.
 * Pass `requireActive` when the rule is being linked to this package: an inactive package would
 * silently withhold the signup credits (same message as referService.requireActiveGrantPackage).
 */
export async function assertGrantPackageExists(
  grantPackageId: string | null | undefined,
  { requireActive = false }: { requireActive?: boolean } = {}
): Promise<void> {
  if (!grantPackageId) return;
  const grantPackage = await grantPackageRepository.findById(grantPackageId);
  if (!grantPackage) {
    throw new BadRequestError(`Grant package ${grantPackageId} not found`);
  }
  if (requireActive && !grantPackage.active) {
    throw new BadRequestError('Grant package is inactive');
  }
}
