import type { AccessContext, LakeAuditPrincipal } from '@bike4mind/common';
import type { ToolContext } from '../base/types';

export type ToolAccessContext = AccessContext & { auditPrincipal?: LakeAuditPrincipal };

/**
 * The data-lake `AccessContext` for a tool call, built from the ToolContext the way
 * apps/client/server/dataLakes/toAccessContext.ts builds it from a request - keep the two in step.
 * Membership comes from the org documents' ACL, never `user.organizationId`, and a platform
 * admin gets no entitlement keys or administered orgs because the gates grant an admin outright.
 *
 * A key-driven turn also carries an `auditPrincipal` (see toolAuditPrincipal); a session turn
 * carries none, so the audit falls back to `userId`.
 */
export async function buildToolAccessContext(
  context: Pick<ToolContext, 'userId' | 'user' | 'entitlementKeys' | 'db' | 'apiKeyId'>
): Promise<ToolAccessContext> {
  const isAdmin = !!context.user.isAdmin;
  const [organizationIds, administeredOrgIds] = await Promise.all([
    context.db.organizations.findMembershipOrgIds(context.userId),
    isAdmin ? Promise.resolve([]) : context.db.organizations.findIdsWithAdminRights(context.userId),
  ]);
  const auditPrincipal = toolAuditPrincipal(context);
  return {
    userId: context.userId,
    isAdmin,
    userTags: context.user.tags ?? [],
    organizationIds,
    entitlementKeys: isAdmin ? [] : (context.entitlementKeys ?? []),
    administeredOrgIds,
    ...(auditPrincipal ? { auditPrincipal } : {}),
  };
}

/**
 * Who to attribute a tool-driven lake write to, or `undefined` for a session turn - the tool-side
 * twin of the routes' `lakeConfigAuditPrincipal` (apps/client/server/dataLakes), same shape.
 */
export function toolAuditPrincipal(context: Pick<ToolContext, 'userId' | 'apiKeyId'>): LakeAuditPrincipal | undefined {
  if (!context.apiKeyId) return undefined;
  return { principalKind: 'apiKey', principalId: context.apiKeyId, onBehalfOfUserId: context.userId };
}
