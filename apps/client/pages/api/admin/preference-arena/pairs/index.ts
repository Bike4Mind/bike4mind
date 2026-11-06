import { ApiKeyScope, arenaPairImportRequestSchema } from '@bike4mind/common';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { adminApi } from '@server/middlewares/adminApi';
import { getArenaService } from '@server/preferenceArena';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { z } from 'zod';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** GET lists pairs (model ids and a gold flag, never the gold answer); POST imports a batch. */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'settings:manage', POST: 'settings:manage' },
})
  .get(async (req, res) => {
    const query = parseOrBadRequest(listQuerySchema, req.query);
    return res.json(await getArenaService(req.logger).listPairs(query));
  })
  .post(async (req, res) => {
    const { pairs } = parseOrBadRequest(arenaPairImportRequestSchema, req.body);
    const inserted = await getArenaService(req.logger).importPairs(req.user!.id, pairs);
    await recordAdminActionFromRequest(req, {
      action: 'settings.arena_pair.imported',
      target: { kind: 'settings', id: 'preference-arena-pairs', displayName: 'Preference arena pairs' },
      summary: `imported ${inserted} preference arena pair${inserted === 1 ? '' : 's'}`,
      details: { inserted, submitted: pairs.length },
    });
    return res.status(201).json({ inserted });
  });

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '4mb' } },
};

export default handler;
