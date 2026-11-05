import { baseApi } from '@server/middlewares/baseApi';
import { disconnectUserConnectionOAuth } from '@server/mcpConnections/connectionService';
import { assertCustomMcpEnabled } from '@server/mcpConnections/customMcpAccess';

const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  const context = await assertCustomMcpEnabled(req.user);
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  res.json(await disconnectUserConnectionOAuth(req.user, context, id));
});

export default handler;
