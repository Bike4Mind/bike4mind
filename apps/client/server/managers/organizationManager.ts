import { Permission } from '@bike4mind/common';
import { Organization, User } from '@bike4mind/database';

import { mongoose } from '@bike4mind/database';

import { IUserObject } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@server/utils/errors';

// NOTE: The functions below are intentionally NOT consolidated into
// @bike4mind/services `organizationService`:
//  - addUserToOrganization carries explicit transaction (ClientSession) support
//    and a different authorization model than organizationService.addMember
//    (which checks the caller's access) - migrating would change behavior. Both
//    now set the User.organizationId side effect (needed for team-wide system
//    prompts and org-scoped access).
//  - assignManager / removeManager have no service equivalent and are not
//    duplicate logic.
// The dead createOrganization / deleteOrganization (which duplicated
// organizationService.create / deleteOrganization) and removeUserFromOrganization
// were removed.

/**
 * @returns true if the user was added to the organization,
 * false if the user was not added or was already in the organization
 */
export async function addUserToOrganization({
  userId,
  organizationId,
  session = null,
  force = false,
}: {
  userId: string | IUserObject;
  organizationId: string | null;
  session?: mongoose.ClientSession | null;
  /**
   * If true, add the user to the organization even if it's at full capacity
   */
  force?: boolean;
}): Promise<boolean> {
  if (!organizationId) return false;
  const user = typeof userId === 'string' ? await User.findById(userId).session(session) : userId;
  if (!user) throw new NotFoundError('User not found');
  const organization = await Organization.findById(organizationId).populate('users.user').session(session);
  if (!organization) return false;

  if (!force && organization.users.length >= organization.seats) {
    throw new BadRequestError('Organization is at full capacity');
  }

  const userInOrg = organization.users?.find(userDetail => userDetail.user?.id === user.id);
  // Already in the org; nothing to do
  if (userInOrg) return false;

  await Organization.updateOne(
    { _id: organizationId },
    {
      $push: {
        users: {
          userId: user.id,
          permissions: [Permission.read],
        },
      },
    }
  ).session(session);

  // Also set the user's organizationId so team-wide system prompts work
  await User.updateOne({ _id: user.id }, { $set: { organizationId } }).session(session);

  return true;
}

/**
 * Assign or update the manager of an organization
 */
export async function assignManager({
  organizationId,
  managerId,
  session = null,
}: {
  organizationId: string;
  managerId: string;
  session?: mongoose.ClientSession | null;
}): Promise<void> {
  const organization = await Organization.findById(organizationId).session(session);
  if (!organization) throw new NotFoundError('Organization not found');

  // Validate that managerId is not the same as the billing owner
  if (managerId === organization.userId) {
    throw new BadRequestError('Manager cannot be the same as the billing owner');
  }

  const manager = await User.findById(managerId).session(session);
  if (!manager) throw new NotFoundError('Manager user not found');

  organization.managerId = managerId;
  await organization.save({ session });
}

/**
 * Remove the manager from an organization
 */
export async function removeManager({
  organizationId,
  session = null,
}: {
  organizationId: string;
  session?: mongoose.ClientSession | null;
}): Promise<void> {
  const organization = await Organization.findById(organizationId).session(session);
  if (!organization) throw new NotFoundError('Organization not found');

  organization.managerId = null;
  await organization.save({ session });
}
