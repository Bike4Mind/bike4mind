import { buildDataLakeAccessContext, type AccessContext, type LakeAuditPrincipal } from '@bike4mind/common';
import type { ToolContext } from '../base/types';

export type ToolAccessContext = AccessContext & { auditPrincipal?: LakeAuditPrincipal };

/**
 * The data-lake `AccessContext` for a tool call - the shared builder fed from the ToolContext.
 *
 * A key-driven turn also carries an `auditPrincipal` (see toolAuditPrincipal); a session turn
 * carries none, so the audit falls back to `userId`.
 */
export async function buildToolAccessContext(
  context: Pick<ToolContext, 'userId' | 'user' | 'entitlementKeys' | 'db' | 'apiKeyId'>
): Promise<ToolAccessContext> {
  const accessContext = await buildDataLakeAccessContext(
    { id: context.userId, isAdmin: context.user.isAdmin, tags: context.user.tags },
    {
      membershipOrgIds: () => context.db.organizations.findMembershipOrgIds(context.userId),
      entitlementKeys: async () => context.entitlementKeys ?? [],
      administeredOrgIds: () => context.db.organizations.findIdsWithAdminRights(context.userId),
    }
  );
  const auditPrincipal = toolAuditPrincipal(context);
  return auditPrincipal ? { ...accessContext, auditPrincipal } : accessContext;
}

/**
 * Who to attribute a tool-driven lake write to, or `undefined` for a session turn - the tool-side
 * twin of the routes' `lakeConfigAuditPrincipal` (apps/client/server/dataLakes), same shape.
 */
export function toolAuditPrincipal(context: Pick<ToolContext, 'userId' | 'apiKeyId'>): LakeAuditPrincipal | undefined {
  if (!context.apiKeyId) return undefined;
  return { principalKind: 'apiKey', principalId: context.apiKeyId, onBehalfOfUserId: context.userId };
}
