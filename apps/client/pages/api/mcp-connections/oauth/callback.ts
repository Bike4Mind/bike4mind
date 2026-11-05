import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertCustomMcpEnabled } from '@server/mcpConnections/customMcpAccess';
import { completeUserConnectionOAuth } from '@server/mcpConnections/oauth/completeOAuth';
import { parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

const callbackBodySchema = z
  .object({
    code: z.string().min(1).max(4096),
    state: z.string().min(1).max(512),
    iss: z.string().max(2048).optional(),
  })
  .strict();

/**
 * The OAuth redirect lands on an SPA route, which posts here with the session's JWT: the API reads
 * the token only from the Authorization header, so the single-use state is bound to the signed-in user.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  rateLimit({ limit: 20, windowMs: 60 * 60 * 1000, bucket: 'POST /api/mcp-connections/oauth/callback' }),
  async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(callbackBodySchema, req.body);
    res.json(await completeUserConnectionOAuth(req.user, context, body));
  }
);

export default handler;
