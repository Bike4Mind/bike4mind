import type { IOrganizationDocument } from '@bike4mind/common';
import { organizationRepository } from '@bike4mind/database';

export type OwnedOrganizations = {
  /** Owned orgs with at least one other member or manager: ownership must be transferred before deleting. */
  shared: IOrganizationDocument[];
  /** Owned orgs nobody else belongs to: deleted with the account at the end of the grace period. */
  soleMember: IOrganizationDocument[];
};

/**
 * Anyone but the owner with a `users[]` row (any permission) or an `adminUserIds` entry counts: deleting
 * the owner would otherwise strand them in an org nobody can bill or administer. Deliberately broader
 * than the membership predicate (orgMembershipFilter), which ignores read-less rows.
 */
function hasOtherMembers(org: IOrganizationDocument, ownerId: string): boolean {
  const others = [...(org.users ?? []).map(member => String(member.userId)), ...(org.adminUserIds ?? []).map(String)];
  return others.some(id => id !== ownerId);
}

/** The live (not soft-deleted) organizations this user is the billing owner of, split by whether anyone else is in them. */
export async function classifyOwnedOrganizations(userId: string): Promise<OwnedOrganizations> {
  const owned = await organizationRepository.find({ userId });
  return {
    shared: owned.filter(org => hasOtherMembers(org, userId)),
    soleMember: owned.filter(org => !hasOtherMembers(org, userId)),
  };
}
