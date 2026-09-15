import { IOrganizationRepository } from '@bike4mind/common';
import { secureParameters, NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const removeManagerSchema = z.object({
  organizationId: z.string(),
});

type RemoveManagerParameters = z.infer<typeof removeManagerSchema>;

interface RemoveManagerAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById' | 'update'>;
  };
}

/**
 * Clear the team manager of an organization. Caller authorization (billing owner
 * or admin) is enforced at the route.
 */
export async function removeManager(parameters: RemoveManagerParameters, adapters: RemoveManagerAdapters) {
  const { db } = adapters;
  const { organizationId } = secureParameters(parameters, removeManagerSchema);

  const organization = await db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');

  return db.organizations.update({ id: organizationId, managerId: null });
}
