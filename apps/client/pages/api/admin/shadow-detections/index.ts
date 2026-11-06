import {
  ApiKeyScope,
  SHADOW_DETECTION_LIST_LIMIT,
  shadowDetectionListQuerySchema,
  shadowDetectionListSchema,
} from '@bike4mind/common';
import { shadowDetectionRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const SHADOW_DETECTIONS_RATE_LIMIT = 60;

/**
 * The admin Detections page: what the abuse detectors would have done (shadow detections), newest
 * first, with per-detector, per-policy verdict counts and the current state of the accounts they name.
 * Read-only; grading is POST ./verdict (one) or ./verdicts (several).
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
})
  .use(rateLimit({ limit: SHADOW_DETECTIONS_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-shadow-detections' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = shadowDetectionListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Unknown detector or verdict filter');
      const [{ data, truncated }, summary] = await Promise.all([
        shadowDetectionRepository.list({ ...parsed.data, limit: SHADOW_DETECTION_LIST_LIMIT }),
        shadowDetectionRepository.summarize(),
      ]);
      const { accounts, burstPeers, reviewers } = await shadowDetectionRepository.listContext(data);
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, shadowDetectionListSchema, { data, truncated, summary, accounts, burstPeers, reviewers });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
