import { ApiKeyScope } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { getArenaService } from '@server/preferenceArena';
import { z } from 'zod';

const bodySchema = z.object({ active: z.boolean() });

/** PATCH /api/admin/preference-arena/pairs/:id - retire or restore a pair. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { PATCH: 'settings:manage' },
}).patch(async (req, res) => {
  const { active } = parseOrBadRequest(bodySchema, req.body);
  await getArenaService(req.logger).setPairActive(String(req.query.id), active);
  return res.json({ active });
});

export default handler;
