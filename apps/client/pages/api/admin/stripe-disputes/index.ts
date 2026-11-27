import {
  ApiKeyScope,
  STRIPE_DISPUTE_LIST_LIMIT,
  stripeDisputeListQuerySchema,
  stripeDisputeListSchema,
} from '@bike4mind/common';
import { stripeDisputeRepository } from '@bike4mind/database';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { respond } from '@server/utils/respond';

const ONE_MINUTE_MS = 60_000;
export const STRIPE_DISPUTES_RATE_LIMIT = 60;

/**
 * The admin Disputes page: every Stripe dispute the webhook recorded, newest first. Read-only;
 * resolving an organization or unmatched dispute is POST ./resolve, undoing a lost dispute's
 * automatic Contain is POST ./undo-contain.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
})
  .use(rateLimit({ limit: STRIPE_DISPUTES_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-stripe-disputes' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = stripeDisputeListQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError('Unknown state or subject filter');
      const { data, truncated } = await stripeDisputeRepository.list({
        ...parsed.data,
        limit: STRIPE_DISPUTE_LIST_LIMIT,
      });
      res.setHeader('Cache-Control', 'private, no-store');
      respond(res, stripeDisputeListSchema, { data, truncated });
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;
