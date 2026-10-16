import { ApiKeyScope, describeRequestedIntegration, type IntegrationDemandResponse } from '@bike4mind/common';
import { integrationRequestRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError } from '@server/utils/errors';

/**
 * GET /api/admin/integrations/demand - roadmap requests per integration, most requested first,
 * for the admin Integration demand tab and for admin-scoped API keys.
 *
 * Every id with a row is listed, including ones since promoted to beta or GA (or dropped from the
 * catalog), so demand history survives the card leaving the roadmap; `stage` says where each one
 * is today. Who filed the requests is on the sibling requesters route, never on the user route
 * (pages/api/integrations/requests.ts), which returns counts only.
 */

const ONE_MINUTE_MS = 60 * 1000;
// One read per tab open plus a refresh now and then; a CLI loop polling it gains nothing faster.
export const INTEGRATION_DEMAND_RATE_LIMIT = 30;

// requiredScopes gates API-key callers only (server/middlewares/baseApi.ts): an admin's key must
// also carry admin:*. Browser sessions rely on the isAdmin check below. rateLimit is chained after
// baseApi so it keys on req.user.id rather than the client IP.
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: INTEGRATION_DEMAND_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-integration-demand' }))
  .get(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const rows = await integrationRequestRepository.demandSummary();
    const body: IntegrationDemandResponse = {
      integrations: rows.map(row => ({
        integrationId: row.integrationId,
        ...describeRequestedIntegration(row.integrationId),
        total: row.total,
        organizations: row.organizations,
        firstRequestedAt: row.firstRequestedAt.toISOString(),
        latestRequestedAt: row.latestRequestedAt.toISOString(),
      })),
    };
    res.setHeader('Cache-Control', 'private, no-store');
    return res.json(body);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
