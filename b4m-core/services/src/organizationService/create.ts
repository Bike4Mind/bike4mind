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
  logger?: { error: (message: string) => void };
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
  //
  // ⚠️ `organizationId` is OVERLOADED (#1428): it is also the BILLING selector. Once it is set,
  // `deductCreditsWithOrgSupport` charges the ORG's `currentCredits` rather than the user's personal
  // balance, with no fallback (#1238 made the org balance a hard stop). `create` starts orgs at 0
  // credits, so on an unfunded path (`POST /api/organizations`, or a grant with `initialCredits: 0`)
  // this points the owner at an empty pool - and `leave` refuses to clear the pointer for an org's
  // own owner, so they cannot undo it themselves. Do NOT "fix" that by gating this write on the org
  // being funded: that reintroduces #1388 for unfunded-org owners. The fields need separating; see
  // #1428.
  const owner = billingOwnerId === user.id ? user : await adapters.db.users.findById(billingOwnerId);
  if (owner && !owner.organizationId) {
    // Best-effort, and intentionally NOT fatal: the org is already committed (there is no surrounding
    // transaction at every call site), so letting a failed pointer write bubble would 500 a create
    // that actually succeeded and leave the owner in exactly the no-active-org state this repairs.
    // A stale pointer is recoverable - #1172 active-org selection can set it later. Note the failure
    // direction is the safe one here: no pointer means no capability scope (the #1388 state), but it
    // also means billing stays on the user's personal balance rather than an empty org pool.
    try {
      await adapters.db.users.update({ id: owner.id, organizationId: organization.id });
    } catch (error) {
      (adapters.logger ?? console).error(
        `Organization ${organization.id} created but failed to set active-org pointer for owner ${owner.id}: ${error}`
      );
    }
  }

  return organization;
};
