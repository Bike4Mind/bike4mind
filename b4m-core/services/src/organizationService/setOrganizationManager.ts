import {
  IOrganizationDocument,
  IOrganizationRepository,
  IUserDocument,
  isOrgOwnerOrPlatformAdmin,
  orgAclRowConfersMembership,
} from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const setOrganizationManagerSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  isManager: z.boolean(),
});

type SetOrganizationManagerParameters = z.infer<typeof setOrganizationManagerSchema>;

interface SetOrganizationManagerAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById' | 'addAdmin' | 'removeAdmin' | 'update'>;
  };
}

export type OrganizationManagerChange = {
  organization: IOrganizationDocument;
  previousAdminUserIds: string[];
  adminUserIds: string[];
  /** False when the member already held (or already lacked) the role; nothing was written. */
  changed: boolean;
};

/**
 * Appoint or remove one org manager (`adminUserIds`). The per-member twin of PUT /admins: that
 * route replaces the whole list from whatever the client last read, so two edits made from stale
 * copies drop each other; this one touches only the named user.
 *
 * Owner-only tier (`isOrgOwnerOrPlatformAdmin`): a manager cannot appoint or remove managers. An
 * unauthorized caller gets the same NotFoundError as a missing org (matches `transferOwnership`).
 * The appointee must hold a member row that confers membership, the same rule PUT /admins applies
 * to an addition.
 */
export async function setOrganizationManager(
  user: IUserDocument,
  parameters: SetOrganizationManagerParameters,
  adapters: SetOrganizationManagerAdapters
): Promise<OrganizationManagerChange> {
  const { organizationId, userId, isManager } = secureParameters(parameters, setOrganizationManagerSchema);
  const { organizations } = adapters.db;

  const organization = await organizations.findById(organizationId);
  if (!organization || !isOrgOwnerOrPlatformAdmin(user, organization)) {
    throw new NotFoundError('Organization not found');
  }
  if (organization.personal) throw new BadRequestError('A personal organization has no managers');
  if (userId === organization.userId) throw new BadRequestError('The owner already manages this organization');

  const previousAdminUserIds = (organization.adminUserIds ?? []).map(String);

  if (isManager) {
    const holdsMemberRow = (organization.users ?? []).some(
      member => String(member.userId) === userId && orgAclRowConfersMembership(member)
    );
    if (!holdsMemberRow) throw new BadRequestError('Only a member of the organization can be made a manager');
    // False when the row vanished between the read and the write (a concurrent removal).
    if (!(await organizations.addAdmin(organizationId, userId))) {
      throw new BadRequestError('Only a member of the organization can be made a manager');
    }
    if ((organization.billingManagerUserIds ?? []).some(id => String(id) === userId)) {
      await organizations.update({
        id: organizationId,
        billingManagerUserIds: (organization.billingManagerUserIds ?? []).filter(id => String(id) !== userId),
      });
    }
  } else {
    await organizations.removeAdmin(organizationId, userId);
  }

  const updated = await organizations.findById(organizationId);
  if (!updated) throw new NotFoundError('Organization not found');

  // Derived from this write, not the re-read, so a concurrent edit by someone else is not
  // attributed to this caller in the audit trail.
  const wasManager = previousAdminUserIds.includes(userId);
  const adminUserIds = isManager
    ? wasManager
      ? previousAdminUserIds
      : [...previousAdminUserIds, userId]
    : previousAdminUserIds.filter(id => id !== userId);

  return { organization: updated, previousAdminUserIds, adminUserIds, changed: wasManager !== isManager };
}
