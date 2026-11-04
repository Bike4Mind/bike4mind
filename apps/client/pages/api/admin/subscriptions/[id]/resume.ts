import { ApiKeyScope } from '@bike4mind/common';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import { isScheduledToCancel } from '@client/app/utils/adminSubscriptionDetail';
import { runAdminStripeWrite } from '@server/admin/stripeWrite/adminStripeWrite';
import { assertLiveStripeRow, cancelScheduleChanges } from '@server/admin/stripeWrite/cancelResumeShared';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

/**
 * POST /api/admin/subscriptions/[id]/resume: clears a scheduled cancellation while the paid period is still
 * running. A separate audited write, never an undo of the cancel entry.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 10, windowMs: 60_000, bucket: 'admin-stripe-write' }))
  .post(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const body = await runAdminStripeWrite({
        req,
        id: req.query.id,
        action: 'billing.subscription.resumed',
        summary: 'resumed the subscription',
        precheck: subscription => {
          assertLiveStripeRow(subscription);
          if (!isScheduledToCancel(subscription)) throw new ConflictError('No cancellation is scheduled.');
          if (!subscription.periodEndsAt || new Date(subscription.periodEndsAt).getTime() <= Date.now()) {
            throw new ConflictError('This subscription has already ended.');
          }
        },
        // Send only the parameter that scheduled the cancel: Stripe accepts one of the two, and an empty cancel_at
        // unsets a custom date.
        params: subscription => (subscription.cancelAtPeriodEnd ? { cancel_at_period_end: false } : { cancel_at: '' }),
        changes: cancelScheduleChanges,
      });
      return res.status(200).json(body);
    })
  );

export default handler;
