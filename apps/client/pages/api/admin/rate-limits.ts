import { Request } from 'express';
import { ApiKeyScope, MODERATION_PAGE_READ } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { RateLimitSnapshot } from '@bike4mind/database';
import { assertParseableDate } from '@server/utils/dateParam';

const handler = adminApi({
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: MODERATION_PAGE_READ },
}).get(async (req: Request, res) => {
  const { dateFrom, dateTo, integration, throttledOnly, limit } = req.query;

  // Build query filter
  const query: Record<string, unknown> = {};

  if (dateFrom || dateTo) {
    const timestampFilter: Record<string, Date> = {};
    assertParseableDate('dateFrom', dateFrom as string | undefined);
    assertParseableDate('dateTo', dateTo as string | undefined);
    if (dateFrom) timestampFilter.$gte = new Date(dateFrom as string);
    if (dateTo) timestampFilter.$lte = new Date(dateTo as string);
    query.timestamp = timestampFilter;
  }

  if (integration) {
    query.integration = integration;
  }

  if (throttledOnly === 'true') {
    query.wasThrottled = true;
  }

  const maxResults = Math.min(Number(limit) || 500, 1000);

  const snapshots = await RateLimitSnapshot.find(query).sort({ timestamp: -1 }).limit(maxResults).lean();

  return res.json(snapshots);
});

export default handler;
