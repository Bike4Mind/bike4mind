import { organizationRepository } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';

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
