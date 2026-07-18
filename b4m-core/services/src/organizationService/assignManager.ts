import { IOrganizationRepository, IUserRepository } from '@bike4mind/common';
import { secureParameters, BadRequestError, NotFoundError } from '@bike4mind/utils';
import { z } from 'zod';

const assignManagerSchema = z.object({
  organizationId: z.string(),
  managerId: z.string(),
});

type AssignManagerParameters = z.infer<typeof assignManagerSchema>;

interface AssignManagerAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById' | 'update'>;
    users: Pick<IUserRepository, 'findById'>;
  };
}

/**
 * Assign or update the team manager of an organization. Caller authorization
 * (billing owner or admin) is enforced at the route; this holds only the
 * business rules: the manager cannot be the billing owner and must be a real user.
 */
export async function assignManager(parameters: AssignManagerParameters, adapters: AssignManagerAdapters) {
  const { db } = adapters;
  const { organizationId, managerId } = secureParameters(parameters, assignManagerSchema);

  const organization = await db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');

  if (managerId === organization.userId) {
    throw new BadRequestError('Manager cannot be the same as the billing owner');
  }

  const manager = await db.users.findById(managerId);
  if (!manager) throw new NotFoundError('Manager user not found');

  return db.organizations.update({ id: organizationId, managerId });
}
