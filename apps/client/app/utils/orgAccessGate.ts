import { type AdministrableOrg, canAdministerOrganization } from '@bike4mind/common';

/**
 * The client's single mirror of the server's `verifyOrgAccess` (server/utils/orgAccess.ts): a
 * platform admin, the org's billing owner, or one of its managers - NOT every member holding manage
 * permissions. It runs the server's own `canAdministerOrganization`, so the two cannot drift, and
 * every surface that offers an owner/manager-only org capability derives from here so none of them
 * can show a control the org routes would answer with a 404.
 *
 * Consumers: the organization route's Analysis tab (`canViewOrgAnalysis`) and the create wizard's
 * GitHub source card, whose create-and-connect door runs this same gate server-side.
 */
export const hasOrgUpdateAccess = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: AdministrableOrg | null | undefined
): boolean => {
  if (!currentUser || !organization) return false;
  return canAdministerOrganization(currentUser, organization);
};
