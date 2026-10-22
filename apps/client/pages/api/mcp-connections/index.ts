import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { rateLimit } from '@server/middlewares/rateLimit';
import { createUserConnection, listUserConnections } from '@server/mcpConnections/connectionService';
import { assertCustomMcpEnabled, resolveCustomMcpContext } from '@server/mcpConnections/customMcpAccess';
import { mcpConnectionCreateBodySchema, parseMcpConnectionBody } from '@server/validators/mcpConnectionValidators';

// Session-only (`jwtOnly`): these are not public API routes and have no contract. Exposing them to
// API keys would mean defining them through `defineEndpoint` first.
const handler = baseApi({ auth: 'jwtOnly' })
  .get(perUserRateLimit('GET /api/mcp-connections'), async (req, res) => {
    const context = await resolveCustomMcpContext(req.user.id);
    // Same as the built-in servers list: with the feature off there is nothing to show.
    if (!context.enabled) return res.json([]);
    res.json(await listUserConnections(req.user, context));
  })
  // Each create probes a user-supplied host, so it is held to 10 an hour (design section 12).
  .post(rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, bucket: 'POST /api/mcp-connections' }), async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const body = parseMcpConnectionBody(mcpConnectionCreateBodySchema, req.body);
    res.status(201).json(await createUserConnection(req.user, context, body));
  });

export default handler;
