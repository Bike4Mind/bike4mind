import {
  IGroupDocument,
  IGroupRepository,
  IOrganizationRepository,
  IUserDocument,
  IUserRepository,
} from '@bike4mind/common';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/utils';

interface GroupMembershipAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findById'>;
    users: Pick<IUserRepository, 'addGroupToUser' | 'removeGroupFromUser'>;
  };
}

interface RenameGroupAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findById' | 'update'>;
  };
}

// The org+group resolution/authorization that every group action shares. groups.update is only
// needed by rename, so it lives on that action's adapter, not this shared subset.
type AuthorizeAdapters = {
  db: {
    organizations: Pick<IOrganizationRepository, 'findById'>;
    groups: Pick<IGroupRepository, 'findById'>;
  };
};

interface GroupMembershipParams {
  organizationId: string;
  groupId: string;
  userId: string;
}

type OrgLike = { userId: string; adminUserIds?: string[]; users: Array<{ userId: string }> };

/**
 * Who may manage an org's group memberships: a platform admin, the org's billing owner, or an
 * appointed org admin (`adminUserIds`). A plain member has no group-management authority.
 */
const assertCanManageOrgGroups = (actingUser: IUserDocument, organization: OrgLike): void => {
  const isPlatformAdmin = actingUser.isAdmin === true;
  const isBillingOwner = organization.userId === actingUser.id;
  // An appointed org admin must ALSO still be a current member. Defence in depth: if a purge of
  // adminUserIds on removal ever misses (or a row predates that fix), this stops a removed admin
  // from retaining group-management authority. The billing owner is checked separately above.
  const isOrgAdmin =
    (organization.adminUserIds ?? []).includes(actingUser.id) &&
    organization.users.some(member => member.userId === actingUser.id);
  if (!isPlatformAdmin && !isBillingOwner && !isOrgAdmin) {
    throw new ForbiddenError("Not authorized to manage this organization's groups");
  }
};

/**
 * Resolve the org + group and enforce the group-membership **write-path invariant**
 * (org-groups #1172 - the single highest-risk path). Every membership write must confirm BOTH:
 *   (1) the target group belongs to the acting admin's organization, AND
 *   (2) the target user is a member of that same organization.
 * `user.groups[]` carries no org qualifier, so skipping (1) lets an admin attach their member to
 * another tenant's group, and skipping (2) lets them attach an outsider to their own group -
 * either omission is cross-tenant access, not a cosmetic bug. Assign requires both; unassign
 * requires (1) only ((2) is not needed to REMOVE, and a departed member should still be cleanable).
 */
async function authorizeAndValidate(
  actingUser: IUserDocument,
  { organizationId, groupId, userId }: { organizationId: string; groupId: string; userId?: string },
  adapters: AuthorizeAdapters,
  requireMembership: boolean
): Promise<void> {
  const organization = await adapters.db.organizations.findById(organizationId);
  if (!organization) throw new NotFoundError('Organization not found');
  assertCanManageOrgGroups(actingUser, organization);

  const group = await adapters.db.groups.findById(groupId);
  if (!group) throw new NotFoundError('Group not found');
  if (group.organizationId !== organizationId) {
    // invariant (1). Same error as a missing group (not a 400): a distinct "belongs to another
    // org" response is an existence oracle that lets a caller confirm a group id lives in a tenant
    // they can't see. Mirrors revokeAccess's "return same error to avoid info leakage".
    throw new NotFoundError('Group not found');
  }
  if (requireMembership && !organization.users.some(member => member.userId === userId)) {
    // invariant (2). BadRequest is fine here - no cross-tenant existence is revealed.
    throw new BadRequestError('User is not a member of this organization');
  }
}

/** Assign a member to a group (idempotent). Enforces both invariant conditions. */
export async function assignUserToGroup(
  actingUser: IUserDocument,
  params: GroupMembershipParams,
  adapters: GroupMembershipAdapters
): Promise<void> {
  await authorizeAndValidate(actingUser, params, adapters, true);
  await adapters.db.users.addGroupToUser(params.userId, params.groupId);
}

/** Remove a member from a group. Enforces invariant (1) so an admin can't touch another tenant's group. */
export async function removeUserFromGroup(
  actingUser: IUserDocument,
  params: GroupMembershipParams,
  adapters: GroupMembershipAdapters
): Promise<void> {
  await authorizeAndValidate(actingUser, params, adapters, false);
  await adapters.db.users.removeGroupFromUser(params.userId, params.groupId);
}

/**
 * Rename a group instance. Same authorization + "group belongs to this org" invariant as the
 * membership writes (requireMembership: false - a rename has no target member), so the predicate
 * and the invariant live in ONE tested place rather than being re-implemented inline in the route.
 */
export async function renameGroup(
  actingUser: IUserDocument,
  { organizationId, groupId, name }: { organizationId: string; groupId: string; name: string },
  adapters: RenameGroupAdapters
): Promise<IGroupDocument | null> {
  await authorizeAndValidate(actingUser, { organizationId, groupId }, adapters, false);
  return adapters.db.groups.update({ id: groupId, name });
}
