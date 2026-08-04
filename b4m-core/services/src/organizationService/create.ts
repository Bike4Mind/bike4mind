import { IOrganizationDocument, IOrganizationRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const createSchema = z.object({
  name: z.string(),
  personal: z.boolean().prefault(false),
  seats: z.number().prefault(1),
  stripeCustomerId: z.string().nullable(),
  billingOwnerId: z.string().optional(), // Optional billing owner (defaults to user if not provided)
  managerId: z.string().optional(), // Optional team manager
});

type CreateParameters = z.infer<typeof createSchema>;

interface CreateAdapters {
  db: {
    organizations: IOrganizationRepository;
    users: Pick<IUserRepository, 'findById' | 'update'>;
  };
}

export const create = async (user: IUserDocument, params: CreateParameters, adapters: CreateAdapters) => {
  const validatedParams = secureParameters(params, createSchema);

  // Determine the billing owner (userId)
  const billingOwnerId = validatedParams.billingOwnerId ?? user.id;

  // Validate that managerId is not the same as the billing owner
  if (validatedParams.managerId && validatedParams.managerId === billingOwnerId) {
    throw new Error('Manager cannot be the same as the billing owner');
  }

  const buildOrganization: Omit<IOrganizationDocument, 'id'> = {
    ...validatedParams,

    /**
     * Set Default Values
     */
    userId: billingOwnerId, // Use billingOwnerId if provided, otherwise default to user
    managerId: validatedParams.managerId ?? null, // Set managerId if provided
    // Org-groups (#1172): a new org starts with no group types and no appointed admins (fail-closed).
    allowedGroupTypes: [],
    adminUserIds: [],
    users: [],
    seats: validatedParams.seats,
    billingContact: user.email!,
    userDetails: [
      {
        id: user.id,
        email: user.email ?? user.username,
        name: user.name,
        usedCredits: 0,
        lastCreditUsedAt: null,
      },
    ],
    description: '',
    currentCredits: 0,
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const organization = await adapters.db.organizations.create(buildOrganization);

  // Give the billing owner an active-org context (#1388). The owner is intentionally NOT a
  // `users[]` member (#1226), but org-scoped resolution derives the active org from
  // `user.organizationId`; without it an owner-only account resolves to no org, so the #1226
  // implicit capability hold (owner holds the org's granted types) never runs for them. Set it
  // only when the owner has none, so we never silently switch the active org of a user who already
  // belongs to one - multi-org owner active-org SELECTION is a separate concern (#1172).
  const owner = billingOwnerId === user.id ? user : await adapters.db.users.findById(billingOwnerId);
  if (owner && !owner.organizationId) {
    await adapters.db.users.update({ id: owner.id, organizationId: organization.id });
  }

  return organization;
};
