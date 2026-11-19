import { ApiKeyScope, HTTPError, PLATFORM_MCP_OWNER } from '@bike4mind/common';
import { mcpConnectionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertCustomMcpEnabled } from '@bike4mind/server-utils/mcpConnections/customMcpAccess';
import { refreshConnectionTools, type RefreshResult } from '@server/mcpConnections/connectionService';
import { recordPlatformConnectorAction } from '@server/mcpConnections/platformConnectorAudit';
import { adminApi } from '@server/middlewares/adminApi';

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'settings:manage' },
}).post(
  // The user refresh route's 20 an hour, in a bucket of its own.
  rateLimit({ limit: 20, windowMs: 60 * 60 * 1000, bucket: 'POST /api/admin/mcp-connections/[id]/refresh-tools' }),
  async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    let result: RefreshResult;
    try {
      result = await refreshConnectionTools(PLATFORM_MCP_OWNER, req.user, context, id);
    } catch (error) {
      // An unknown id has no connector to name, so it is not audited.
      const connection = await mcpConnectionRepository.findByIdForOwner(id, PLATFORM_MCP_OWNER);
      if (connection) {
        const code = error instanceof HTTPError ? error.additionalInfo?.code : undefined;
        await recordPlatformConnectorAction(
          req,
          'settings.mcp_connector.tools_refreshed',
          connection,
          'failed to refresh the tools of',
          { details: { outcome: 'failed', errorCode: typeof code === 'string' ? code : 'unknown' } }
        );
      }
      throw error;
    }
    const { added, changed, removed, dropped } = result.discovery;
    await recordPlatformConnectorAction(
      req,
      'settings.mcp_connector.tools_refreshed',
      result.connection,
      'refreshed the tools of',
      { details: { added: added.length, changed: changed.length, removed: removed.length, dropped } }
    );
    res.json(result);
  }
);

export default handler;
