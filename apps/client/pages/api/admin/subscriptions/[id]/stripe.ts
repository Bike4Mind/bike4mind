import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { AdminSubscriptionStripeParamsSchema } from '@client/app/utils/adminSubscriptionStripe';
import { getAdminSubscriptionStripe } from '@server/admin/subscriptionStripe/getAdminSubscriptionStripe';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

// Stripe SDK error `type`s that mean Stripe, not this app, failed.
const UPSTREAM_ERROR_TYPES = new Set(['StripeConnectionError', 'StripeRateLimitError', 'StripeAPIError']);

const isUpstreamError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && UPSTREAM_ERROR_TYPES.has(String((error as { type?: unknown }).type));

/**
 * One subscription's live Stripe data: GET /api/admin/subscriptions/[id]/stripe, where `id` is the Mongo id.
 * Read-only. Separate from the detail route so a Stripe failure never blanks the rest of the page.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-subscription-stripe' }))
  .get(
    asyncHandler(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const parsed = AdminSubscriptionStripeParamsSchema.safeParse(req.query);
      if (!parsed.success) throw new NotFoundError('Subscription not found');
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const stripe = await getAdminSubscriptionStripe(parsed.data.id, { fresh: parsed.data.fresh });
        if (!stripe) throw new NotFoundError('Subscription not found');
        return res.json(stripe);
      } catch (error) {
        if (!isUpstreamError(error)) throw error;
        req.logger?.error('Admin subscription Stripe read failed', error);
        return res.status(502).json({ message: "Couldn't reach Stripe" });
      }
    })
  );

export default handler;
