import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { getArenaService } from '@server/preferenceArena';

const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'settings:manage' },
}).get(async (req, res) => res.json(await getArenaService(req.logger).getArenaStats()));

export default handler;
