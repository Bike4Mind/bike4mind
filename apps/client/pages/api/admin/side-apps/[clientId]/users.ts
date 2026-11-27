import { adminApi } from '@server/middlewares/adminApi';
import { z } from 'zod';
import { readSideAppUsers } from '@server/admin/sideApps/readSideAppUsers';

const QuerySchema = z.object({
  clientId: z.string().min(1).max(256),
  days: z.coerce.number().finite().optional(),
});

/** GET /api/admin/side-apps/[clientId]/users - one row per user of a connected app, by credits. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(async (req, res) => {
  const { clientId, days = 30 } = QuerySchema.parse(req.query);
  return res.json(await readSideAppUsers(clientId, days));
});

export default handler;
