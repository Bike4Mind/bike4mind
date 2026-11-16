import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  IOrganizationRepository,
  ISpaceDocument,
  ISpaceRepository,
  IUserDocument,
  IUserRepository,
  canAdministerOrganization,
  isSpaceOwner,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { loadForMember } from './loadForMember';

const transferOwnershipSchema = z.object({
  spaceId: z.string().min(1),
  newOwnerId: z.string().min(1),
});

type TransferOwnershipParameters = z.infer<typeof transferOwnershipSchema>;

interface TransferOwnershipAdapters {
  db: {
    spaces: Pick<ISpaceRepository, 'findLiveById' | 'transferOwnership'>;
    organizations: Pick<IOrganizationRepository, 'findById'>;
    users: Pick<IUserRepository, 'findById'>;
  };
}

/**
 * Hands the Space to one of its admins; the former owner becomes an admin. The parent organization
 * is cleared when the new owner does not administer it.
 */
export async function transferOwnership(
  user: IUserDocument,
  parameters: TransferOwnershipParameters,
  adapters: TransferOwnershipAdapters
): Promise<ISpaceDocument> {
  const { spaceId, newOwnerId } = secureParameters(parameters, transferOwnershipSchema);
  const { db } = adapters;

  const space = await loadForMember(db.spaces, user.id, spaceId);
  if (!isSpaceOwner(user.id, space)) throw new ForbiddenError('Only the owner can transfer a Space');
  if (newOwnerId === user.id) throw new BadRequestError('You already own this Space');
  if (!space.members.some(m => m.userId === newOwnerId && m.role === 'admin')) {
    throw new BadRequestError('Ownership can only be transferred to a Space admin');
  }

  const newOwner = await db.users.findById(newOwnerId);
  if (!newOwner) throw new NotFoundError('New owner not found');
  if (newOwner.deletion?.scheduledFor) {
    throw new ConflictError('An account scheduled for deletion cannot own a Space.');
  }
  if (newOwner.isBanned) throw new ConflictError('A deactivated account cannot own a Space.');

  let clearParent = false;
  if (space.parentOrganizationId) {
    const parent = await db.organizations.findById(space.parentOrganizationId);
    clearParent = !parent || !canAdministerOrganization(newOwner, parent);
  }

  const updated = await db.spaces.transferOwnership(spaceId, user.id, newOwnerId, { clearParent });
  if (!updated) throw new ConflictError('The Space changed during the transfer. Reload and try again.');
  return updated;
}
