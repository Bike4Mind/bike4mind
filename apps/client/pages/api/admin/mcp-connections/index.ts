import { ApiKeyScope, PLATFORM_MCP_OWNER, SETTINGS_PAGE_READ } from '@bike4mind/common';
import {
  assertCustomMcpEnabled,
  resolveCustomMcpContext,
} from '@bike4mind/server-utils/mcpConnections/customMcpAccess';
import { createConnection, listPlatformConnections } from '@server/mcpConnections/connectionService';
import { recordPlatformConnectorAction } from '@server/mcpConnections/platformConnectorAudit';
import { adminApi } from '@server/middlewares/adminApi';
import {
  mcpPlatformConnectionCreateBodySchema,
  parseMcpConnectionBody,
} from '@server/validators/mcpConnectionValidators';

// Platform connectors: a connection an admin sets up once and every user gets. Session-only, like
// the user routes under pages/api/mcp-connections, which these mirror.
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: SETTINGS_PAGE_READ, POST: 'settings:manage' },
})
  // Not gated: with connectors switched off an admin still sees what is set up.
  .get(async (req, res) => {
    res.json(await listPlatformConnections(await resolveCustomMcpContext(req.user.id)));
  })
  .post(async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(mcpPlatformConnectionCreateBodySchema, req.body);
    const connection = await createConnection(PLATFORM_MCP_OWNER, req.user, context, body);
    await recordPlatformConnectorAction(req, 'settings.mcp_connector.created', connection, 'created', {
      details: { authKind: connection.auth.kind, status: connection.status },
    });
    res.status(201).json(connection);
  });

export default handler;
