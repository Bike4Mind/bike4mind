import type { IMcpConnectionPublic } from '@bike4mind/common';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

type AuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];
type AuditInput = Parameters<typeof recordAdminActionFromRequest>[1];

/**
 * The admin audit entry for one write to a platform connector
 * (pages/api/admin/mcp-connections/**). It names the connector by slug and host only: the URL
 * path and the key never reach the audit log.
 */
export function recordPlatformConnectorAction(
  req: AuditRequest,
  action: Extract<AuditInput['action'], `settings.mcp_connector.${string}`>,
  connection: Pick<IMcpConnectionPublic, 'id' | 'slug' | 'displayName' | 'urlHost'>,
  verb: string,
  extra: Pick<AuditInput, 'changes' | 'details'> = {}
) {
  return recordAdminActionFromRequest(req, {
    action,
    target: { kind: 'settings', id: connection.id, displayName: `${connection.displayName} MCP connector` },
    summary: `${verb} platform MCP connector ${connection.slug} on ${connection.urlHost}`,
    ...extra,
  });
}
