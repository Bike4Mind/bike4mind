import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { rotateUserConnectionApiKey } from '@server/mcpConnections/connectionService';
import { assertCustomMcpEnabled } from '@server/mcpConnections/customMcpAccess';
import { mcpConnectionApiKeyBodySchema, parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

const handler = baseApi({ auth: 'jwtOnly' }).post(
  // A rotation re-probes the server, so it shares the create budget's shape: 10 an hour.
  rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, bucket: 'POST /api/mcp-connections/[id]/api-key' }),
  async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(mcpConnectionApiKeyBodySchema, req.body);
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    res.json(await rotateUserConnectionApiKey(req.user, context, id, body));
  }
);

export default handler;
