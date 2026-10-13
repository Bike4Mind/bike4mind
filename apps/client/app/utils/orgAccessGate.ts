/**
 * The client's single mirror of the server's `verifyOrgAccess` (server/utils/orgAccess.ts): a
 * platform admin, the org's billing owner, or its team manager - NOT every member holding manage
 * permissions. Every surface that offers an owner/manager-only org capability derives from here, so
 * none of them can show a control the org routes would answer with a 404.
 *
 * Consumers: the organization route's Usage/Analysis tabs (`canViewOrgUsage`) and the create
 * wizard's GitHub source card, whose create-and-connect door runs this same gate server-side.
 */
export const hasOrgUpdateAccess = (
  currentUser: { id: string; isAdmin?: boolean | null } | null | undefined,
  organization: { userId: string; managerId?: string | null } | null | undefined
): boolean => {
  if (!currentUser || !organization) return false;
  if (currentUser.isAdmin) return true;
  if (currentUser.id === organization.userId) return true;
  return organization.managerId === currentUser.id;
};
