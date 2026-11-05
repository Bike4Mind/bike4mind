import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { assertCustomMcpEnabled } from '@server/mcpConnections/customMcpAccess';
import { startUserConnectionOAuth } from '@server/mcpConnections/oauth/startOAuth';
import { parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

/** Only for a server that offers no registration: the client the user got from the provider (write-only). */
const startBodySchema = z
  .object({
    clientId: z.string().trim().min(1).max(512).optional(),
    clientSecret: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .refine(body => body.clientSecret === undefined || body.clientId !== undefined, {
    message: 'A client id is required',
  });

const handler = baseApi({ auth: 'jwtOnly' }).post(
  rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, bucket: 'POST /api/mcp-connections/[id]/oauth/start' }),
  async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(startBodySchema, req.body ?? {});
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    res.json(
      await startUserConnectionOAuth(req.user, context, id, {
        manual: body.clientId ? { clientId: body.clientId, clientSecret: body.clientSecret } : undefined,
      })
    );
  }
);

export default handler;
