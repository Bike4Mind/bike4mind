import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { refreshUserConnectionTools } from '@server/mcpConnections/connectionService';
import { assertCustomMcpEnabled } from '@server/mcpConnections/customMcpAccess';

const handler = baseApi({ auth: 'jwtOnly' }).post(
  // Shared per user across connections, not per id: 20 refreshes an hour (design section 12).
  rateLimit({ limit: 20, windowMs: 60 * 60 * 1000, bucket: 'POST /api/mcp-connections/[id]/refresh-tools' }),
  async (req, res) => {
    const context = await assertCustomMcpEnabled(req.user);
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    res.json(await refreshUserConnectionTools(req.user, context, id));
  }
);

export default handler;
