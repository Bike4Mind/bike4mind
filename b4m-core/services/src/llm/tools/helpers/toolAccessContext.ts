import type { AccessContext } from '@bike4mind/common';
import type { ToolContext } from '../base/types';

/**
 * The data-lake `AccessContext` for a tool call, built from the ToolContext the way
 * apps/client/server/dataLakes/toAccessContext.ts builds it from a request - keep the two in step.
 * Membership comes from the org documents' ACL, never `user.organizationId`, and a platform
 * admin gets no entitlement keys or administered orgs because the gates grant an admin outright.
 */
export async function buildToolAccessContext(
  context: Pick<ToolContext, 'userId' | 'user' | 'entitlementKeys' | 'db'>
): Promise<AccessContext> {
  const isAdmin = !!context.user.isAdmin;
  const [organizationIds, administeredOrgIds] = await Promise.all([
    context.db.organizations.findMembershipOrgIds(context.userId),
    isAdmin ? Promise.resolve([]) : context.db.organizations.findIdsWithAdminRights(context.userId),
  ]);
  return {
    userId: context.userId,
    isAdmin,
    userTags: context.user.tags ?? [],
    organizationIds,
    entitlementKeys: isAdmin ? [] : (context.entitlementKeys ?? []),
    administeredOrgIds,
  };
}
