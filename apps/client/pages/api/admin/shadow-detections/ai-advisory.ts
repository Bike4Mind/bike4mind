import { ApiKeyScope } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { aiAdvisorySummarySchema } from '@client/app/utils/aiAdvisory';
import { listAiAbuseAdvisories } from '@server/admin/aiAdvisory/aiAbuseAdvisories';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const AI_ADVISORY_RATE_LIMIT = 60;

/**
 * GET /api/admin/shadow-detections/ai-advisory: accounts the AI judged as abuse on unreviewed
 * detections, with the IPs and mail domains they share. Read-only; see listAiAbuseAdvisories.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
})
  .use(rateLimit({ limit: AI_ADVISORY_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-ai-advisory' }))
  .get(
    asyncHandler(async (_req, res) => {
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, aiAdvisorySummarySchema, await listAiAbuseAdvisories());
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
