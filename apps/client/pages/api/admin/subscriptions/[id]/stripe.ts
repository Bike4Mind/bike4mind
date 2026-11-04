import { ApiKeyScope } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { AdminSubscriptionStripeParamsSchema } from '@client/app/utils/adminSubscriptionStripe';
import { getAdminSubscriptionStripe } from '@server/admin/subscriptionStripe/getAdminSubscriptionStripe';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@server/middlewares/rateLimit';

// Every Stripe SDK error (outage, timeout, auth, permission, invalid request) carries a `Stripe*` type. All of
// them are upstream: answering 502 stops the client retrying a config problem and keeps it in the logs.
const isStripeError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && String((error as { type?: unknown }).type).startsWith('Stripe');

/**
 * One subscription's live Stripe data: GET /api/admin/subscriptions/[id]/stripe, where `id` is the Mongo id.
 * Read-only. Separate from the detail route so a Stripe failure never blanks the rest of the page.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'support:read' },
})
  .use(rateLimit({ limit: 60, windowMs: 60_000, bucket: 'admin-subscription-stripe' }))
  .get(
    asyncHandler(async (req, res) => {
      const parsed = AdminSubscriptionStripeParamsSchema.safeParse(req.query);
      if (!parsed.success) throw new NotFoundError('Subscription not found');
      res.setHeader('Cache-Control', 'private, no-store');
      try {
        const stripe = await getAdminSubscriptionStripe(parsed.data.id, {
          fresh: parsed.data.fresh,
          logger: req.logger,
        });
        if (!stripe) throw new NotFoundError('Subscription not found');
        return res.json(stripe);
      } catch (error) {
        if (!isStripeError(error)) throw error;
        req.logger?.error('Admin subscription Stripe read failed', error);
        return res.status(502).json({ message: "Stripe request failed" });
      }
    })
  );

export default handler;
