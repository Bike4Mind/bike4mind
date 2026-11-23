import { type AdministrableOrg, hasOrgPermission } from '@bike4mind/common';

/**
 * The client's mirror of the server's `verifyOrgPermission(..., 'manageContent')` (orgAccess.ts), the
 * gate the lake connector routes run: a platform admin, the org's billing owner, or one of its
 * managers - NOT every member holding manage permissions. It asks the server's own
 * `hasOrgPermission`, so the two cannot drift.
 *
 * Consumer: the create wizard's GitHub source card, whose create-and-connect door runs this same
 * gate server-side.
 */
export const hasOrgUpdateAccess = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: AdministrableOrg | null | undefined
): boolean => {
  if (!currentUser || !organization) return false;
  return hasOrgPermission(currentUser, organization, 'manageContent');
};
