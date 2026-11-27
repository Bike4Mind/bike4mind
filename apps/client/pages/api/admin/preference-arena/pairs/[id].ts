import { ApiKeyScope } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { getArenaService } from '@server/preferenceArena';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { z } from 'zod';

const bodySchema = z.object({ active: z.boolean() });

/** PATCH /api/admin/preference-arena/pairs/:id - retire or restore a pair. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { PATCH: 'settings:manage' },
}).patch(async (req, res) => {
  const { active } = parseOrBadRequest(bodySchema, req.body);
  const pairId = String(req.query.id);
  await getArenaService(req.logger).setPairActive(pairId, active);
  await recordAdminActionFromRequest(req, {
    action: active ? 'settings.arena_pair.restored' : 'settings.arena_pair.retired',
    target: { kind: 'settings', id: pairId, displayName: `preference arena pair ${pairId}` },
    summary: `${active ? 'restored' : 'retired'} preference arena pair ${pairId}`,
    details: { active },
  });
  return res.json({ active });
});

export default handler;
