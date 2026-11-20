import { ApiKeyScope, PLATFORM_MCP_OWNER } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertCustomMcpEnabled } from '@bike4mind/server-utils/mcpConnections/customMcpAccess';
import { rotateConnectionApiKey } from '@server/mcpConnections/connectionService';
import { recordPlatformConnectorAction } from '@server/mcpConnections/platformConnectorAudit';
import { adminApi } from '@server/middlewares/adminApi';
import { mcpConnectionApiKeyBodySchema, parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { POST: 'settings:manage' },
}).post(
  // A rotation re-probes the server: the user rotation route's 10 an hour.
  rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, bucket: 'POST /api/admin/mcp-connections/[id]/api-key' }),
  async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(mcpConnectionApiKeyBodySchema, req.body);
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const connection = await rotateConnectionApiKey(PLATFORM_MCP_OWNER, req.user, context, id, body);
    await recordPlatformConnectorAction(
      req,
      'settings.mcp_connector.api_key_rotated',
      connection,
      'rotated the key of',
      { details: { status: connection.status } }
    );
    res.json(connection);
  }
);

export default handler;
