import { canAccessAdmin } from '@bike4mind/common';
import { adminApi } from '@server/middlewares/adminApi';
import { apiKeyUsageLogRepository } from '@bike4mind/database';
import { API_KEY_COMPLETION_SOURCES, ApiKeyScope, type IPlatformEndpointUsageResponse } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';

/** ApiKeyUsageLog's 90-day TTL: no endpoint data exists beyond this. */
const ENDPOINT_TTL_DAYS = 90;

const QuerySchema = z.object({
  // Only api/cli/desktop traffic is logged, so no other source can match. Omit to span all
  // plus rows logged before source stamping existed (a source filter cannot match those).
  source: z.enum(API_KEY_COMPLETION_SOURCES).optional(),
});

/**
 * GET /api/admin/platform-usage/endpoints - ApiKeyUsageLog endpoint/latency rollup
 * (request counts only, no credits) over the log's full TTL window. Independent of
 * /api/admin/platform-usage so the two admin dashboard sections filter separately.
 * Admin-only; requiredScopes gates the API-key path as on the sibling route.
 */
const api = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] });
const handler = api.get(async (req, res) => {
  if (!req.user) {
    throw new ForbiddenError('Authentication required');
  }
  if (!canAccessAdmin(req.user)) {
    throw new ForbiddenError('Admin access required');
  }

  const { source } = QuerySchema.parse(req.query);

  const endpoints = await apiKeyUsageLogRepository.platformEndpointUsage({ days: ENDPOINT_TTL_DAYS, source });

  const response: IPlatformEndpointUsageResponse = { source, windowDays: ENDPOINT_TTL_DAYS, endpoints };

  return res.json(response);
});

export default handler;
