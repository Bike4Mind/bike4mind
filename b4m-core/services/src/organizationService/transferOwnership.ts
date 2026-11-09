import {
  ConflictError,
  IOrganizationRepository,
  IUserDocument,
  IUserRepository,
  Permission,
  isOrgOwnerOrPlatformAdmin,
  orgAclRowConfersMembership,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const transferOwnershipSchema = z.object({
  organizationId: z.string().min(1),
  newOwnerId: z.string().min(1),
});

type TransferOwnershipParameters = z.infer<typeof transferOwnershipSchema>;

interface TransferOwnershipAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById' | 'update' | 'ensureUserDetails'>;
    users: Pick<IUserRepository, 'findById'>;
  };
}

export interface TransferOwnershipResult {
  organizationId: string;
  organizationName: string;
  /** Null when the organization pointed at a user that no longer exists. */
  previousOwnerId: string | null;
  newOwnerId: string;
  /** True when `billingContact` followed the new owner, so the caller can mirror it to the payment provider. */
  billingContactChanged: boolean;
  billingContact: string | null;
  stripeCustomerId: string | null;
}

/**
 * Hands the organization's billing ownership (`userId`) to one of its existing admins.
 *
 * The subscription and the Stripe customer belong to the organization, not to the owner, so nothing
 * is re-parented; billing access follows `userId`. The owner is not a `users[]` row but still holds a
 * seat, so the previous owner takes the new owner's roster slot and the seat count is unchanged.
 * `billingContact` is rewritten only when it still names the previous owner; a deliberately set
 * billing address is left alone.
 *
 * Caller should wrap this in withTransaction and mirror a changed `billingContact` to Stripe after commit.
 */
export async function transferOwnership(
  user: IUserDocument,
  parameters: TransferOwnershipParameters,
  adapters: TransferOwnershipAdapters
): Promise<TransferOwnershipResult> {
  const { organizationId, newOwnerId } = secureParameters(parameters, transferOwnershipSchema);
  const { db } = adapters;

  const organization = await db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');

  if (!isOrgOwnerOrPlatformAdmin(user, organization)) {
    throw new ForbiddenError('Only the billing owner or a platform admin can transfer ownership');
  }
  if (organization.personal) throw new BadRequestError('A personal organization cannot be transferred');
  if (newOwnerId === organization.userId) throw new BadRequestError('That user already owns this organization');

  const isAdmin = (organization.adminUserIds ?? []).some(id => String(id) === newOwnerId);
  const holdsMemberRow = (organization.users ?? []).some(
    member => String(member.userId) === newOwnerId && orgAclRowConfersMembership(member)
  );
  if (!isAdmin || !holdsMemberRow) {
    throw new BadRequestError('Ownership can only be transferred to an existing organization admin');
  }

  const newOwner = await db.users.findById(newOwnerId);
  if (!newOwner) throw new NotFoundError('New owner not found');
  if (newOwner.deletion?.scheduledFor) {
    throw new ConflictError('An account scheduled for deletion cannot own an organization.');
  }

  // A platform admin repairing an org whose owner was already deleted lands here with no previous owner.
  const previousOwner = await db.users.findById(organization.userId);

  const users = (organization.users ?? []).filter(member => String(member.userId) !== newOwnerId);
  if (previousOwner && !users.some(member => String(member.userId) === previousOwner.id)) {
    users.push({ userId: previousOwner.id, permissions: [Permission.read] });
  }
  const adminUserIds = (organization.adminUserIds ?? []).filter(id => String(id) !== newOwnerId);

  const billingContactChanged =
    !!previousOwner?.email &&
    !!newOwner.email &&
    organization.billingContact?.trim().toLowerCase() === previousOwner.email.trim().toLowerCase();
  const billingContact = billingContactChanged ? newOwner.email! : (organization.billingContact ?? null);

  await db.organizations.update({
    id: organization.id,
    userId: newOwnerId,
    users,
    adminUserIds,
    ...(billingContactChanged ? { billingContact } : {}),
  });

  if (previousOwner) {
    await db.organizations.ensureUserDetails(organization.id, {
      id: previousOwner.id,
      email: previousOwner.email ?? previousOwner.username,
      name: previousOwner.name,
    });
  }

  return {
    organizationId: organization.id,
    organizationName: organization.name,
    previousOwnerId: previousOwner?.id ?? null,
    newOwnerId,
    billingContactChanged,
    billingContact,
    stripeCustomerId: organization.stripeCustomerId ?? null,
  };
}
