import { ApiKeyScope, PLATFORM_MCP_OWNER } from '@bike4mind/common';
import { assertCustomMcpEnabled } from '@bike4mind/server-utils/mcpConnections/customMcpAccess';
import { refreshConnectionTools } from '@server/mcpConnections/connectionService';
import { recordPlatformConnectorAction } from '@server/mcpConnections/platformConnectorAudit';
import { adminApi } from '@server/middlewares/adminApi';

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'settings:manage' },
}).post(async (req, res) => {
  const context = await assertCustomMcpEnabled(req.user);
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  const result = await refreshConnectionTools(PLATFORM_MCP_OWNER, req.user, context, id);
  const { added, changed, removed, dropped } = result.discovery;
  await recordPlatformConnectorAction(
    req,
    'settings.mcp_connector.tools_refreshed',
    result.connection,
    'refreshed the tools of',
    { details: { added: added.length, changed: changed.length, removed: removed.length, dropped } }
  );
  res.json(result);
});

export default handler;
