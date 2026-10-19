import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import {
  deleteUserConnection,
  getUserConnection,
  updateUserConnection,
} from '@server/mcpConnections/connectionService';
import { assertCustomMcpEnabled } from '@server/mcpConnections/customMcpAccess';
import { mcpConnectionPatchBodySchema, parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

const connectionId = (query: { id?: string | string[] }): string => (typeof query.id === 'string' ? query.id : '');

const handler = baseApi({ auth: 'jwtOnly' })
  .get(perUserRateLimit('GET /api/mcp-connections/[id]'), async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    res.json(await getUserConnection(req.user, context, connectionId(req.query)));
  })
  .patch(perUserRateLimit('PATCH /api/mcp-connections/[id]'), async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(mcpConnectionPatchBodySchema, req.body);
    res.json(await updateUserConnection(req.user, context, connectionId(req.query), body));
  })
  // Not gated: like the built-in servers, a user can always remove a connection.
  .delete(perUserRateLimit('DELETE /api/mcp-connections/[id]'), async (req, res) => {
    await deleteUserConnection(req.user, connectionId(req.query));
    res.status(204).end();
  });

export default handler;
