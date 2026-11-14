import {
  ASSIGNABLE_ORG_ROLES,
  canAssignOrgRole,
  hasOrgPermission,
  IOrganizationDocument,
  IOrganizationRepository,
  IUserDocument,
  orgAclRowConfersMembership,
  organizationMemberRole,
  type AssignableOrgRole,
  type OrganizationMemberRole,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const setOrganizationMemberRoleSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(ASSIGNABLE_ORG_ROLES),
});

type SetOrganizationMemberRoleParameters = z.infer<typeof setOrganizationMemberRoleSchema>;

interface SetOrganizationMemberRoleAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById' | 'setMemberRole'>;
  };
}

export type OrganizationMemberRoleChange = {
  organization: IOrganizationDocument;
  previousRole: OrganizationMemberRole;
  role: AssignableOrgRole;
  /** False when the member already held the role; nothing was written. */
  changed: boolean;
};

const NOT_A_MEMBER = 'Only a member of the organization can be given a role';

/**
 * Give one member of an organization one assignable role (Manager, Billing manager or Member). Who
 * may assign what is `canAssignOrgRole`; Owner moves only through `transferOwnership`.
 *
 * A caller without `manageMembers` gets the same NotFoundError as a missing org (matches the org
 * routes' `verifyOrgPermission`); one who holds it but may not make this particular change gets a
 * ForbiddenError. Manager and Billing manager need a roster row that confers membership.
 */
export async function setOrganizationMemberRole(
  user: IUserDocument,
  parameters: SetOrganizationMemberRoleParameters,
  adapters: SetOrganizationMemberRoleAdapters
): Promise<OrganizationMemberRoleChange> {
  const { organizationId, userId, role } = secureParameters(parameters, setOrganizationMemberRoleSchema);
  const { organizations } = adapters.db;

  const organization = await organizations.findById(organizationId);
  if (!organization || !hasOrgPermission(user, organization, 'manageMembers')) {
    throw new NotFoundError('Organization not found');
  }
  if (organization.personal) throw new BadRequestError('A personal organization has no roles to assign');
  if (userId === organization.userId) {
    throw new BadRequestError("The owner's role changes only by transferring ownership");
  }

  const previousRole = organizationMemberRole(organization, userId);
  if (previousRole === null) throw new BadRequestError(NOT_A_MEMBER);
  if (!canAssignOrgRole(user, organization, userId, role)) {
    throw new ForbiddenError('You cannot give this member that role');
  }
  if (previousRole === role) return { organization, previousRole, role, changed: false };

  if (role !== 'member') {
    const holdsMemberRow = (organization.users ?? []).some(
      member => String(member.userId) === userId && orgAclRowConfersMembership(member)
    );
    if (!holdsMemberRow) throw new BadRequestError(NOT_A_MEMBER);
  }
  // False when the row vanished between the read and the write (a concurrent removal).
  if (!(await organizations.setMemberRole(organizationId, userId, role))) {
    throw new BadRequestError(NOT_A_MEMBER);
  }

  const updated = await organizations.findById(organizationId);
  if (!updated) throw new NotFoundError('Organization not found');

  return { organization: updated, previousRole, role, changed: true };
}
