import { ApiKeyScope } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { z } from 'zod';
import { readSideApps } from '@server/admin/sideApps/readSideApps';

const QuerySchema = z.object({
  // Clamped to 1-365 in resolveWindows rather than rejected.
  days: z.coerce.number().finite().optional(),
});

/**
 * GET /api/admin/side-apps - per connected app: spend by payer tier, requests, outcomes and refusals.
 * Spend spans up to 365 days; requests, outcomes and refusals stop at the 90-day log retention.
 */
const handler = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] }).get(
  async (req, res) => {
    const { days = 30 } = QuerySchema.parse(req.query);
    return res.json(await readSideApps(days));
  }
);

export default handler;
