import { z } from 'zod';
import { BadRequestError } from '@bike4mind/common';
import { spendFreezeService } from '@bike4mind/services';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { buildSpendFreezeAdapters, scopeSchema } from '@server/utils/spendFreezeAdmin';

const MAX_LIMIT = 200;

const historyQuerySchema = scopeSchema.extend({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
});

// Every freeze (active and lifted) a scope has had, newest first.
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } }).get(
  asyncHandler(async (req, res) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid query');
    const { limit, ...scope } = parsed.data;

    const items = await spendFreezeService.getFreezeHistory(scope, limit, buildSpendFreezeAdapters(req.logger));
    return res.json({ items });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
