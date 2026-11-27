import { ApiKeyScope, PLATFORM_MCP_OWNER, SETTINGS_PAGE_READ } from '@bike4mind/common';
import { resolveCustomMcpContext } from '@bike4mind/server-utils/mcpConnections/customMcpAccess';
import { deleteConnection, getConnection, updateConnection } from '@server/mcpConnections/connectionService';
import { recordPlatformConnectorAction } from '@server/mcpConnections/platformConnectorAudit';
import { adminApi } from '@server/middlewares/adminApi';
import { mcpConnectionPatchBodySchema, parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

const connectionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: SETTINGS_PAGE_READ, PATCH: 'settings:manage', DELETE: 'settings:manage' },
})
  .get(async (req, res) => {
    const context = await resolveCustomMcpContext(req.user.id);
    res.json(await getConnection(PLATFORM_MCP_OWNER, context, connectionId(req.query)));
  })
  // Not gated, and it reaches no remote server: switching a connector off must always work.
  .patch(async (req, res) => {
    const context = await resolveCustomMcpContext(req.user.id);
    const body = parseMcpConnectionBody(mcpConnectionPatchBodySchema, req.body);
    const id = connectionId(req.query);
    const before = await getConnection(PLATFORM_MCP_OWNER, context, id);
    const connection = await updateConnection(PLATFORM_MCP_OWNER, req.user, context, id, body);
    // The description's length goes to the audit log, never its text.
    const description = connection.description ?? '';
    const details = {
      ...(body.tools ? { reviewedTools: body.tools.length } : {}),
      ...(description !== (before.description ?? '') ? { descriptionLength: description.length } : {}),
    };
    await recordPlatformConnectorAction(req, 'settings.mcp_connector.updated', connection, 'updated', {
      changes: [
        { field: 'displayName', before: before.displayName, after: connection.displayName },
        { field: 'enabled', before: before.enabled, after: connection.enabled },
      ].filter(change => change.before !== change.after),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    });
    res.json(connection);
  })
  .delete(async (req, res) => {
    const deleted = await deleteConnection(PLATFORM_MCP_OWNER, req.user, connectionId(req.query));
    await recordPlatformConnectorAction(req, 'settings.mcp_connector.deleted', deleted, 'deleted');
    res.status(204).end();
  });

export default handler;
