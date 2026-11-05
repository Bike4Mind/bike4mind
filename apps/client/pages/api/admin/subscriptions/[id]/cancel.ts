import { ApiKeyScope } from '@bike4mind/common';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import { isScheduledToCancel } from '@client/app/utils/adminSubscriptionDetail';
import { runAdminStripeWrite } from '@server/admin/stripeWrite/adminStripeWrite';
import { assertLiveStripeRow, cancelScheduleChanges } from '@server/admin/stripeWrite/cancelResumeShared';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

/**
 * POST /api/admin/subscriptions/[id]/cancel: schedules the Stripe subscription to cancel at the end of the paid
 * period. Access and credits continue until then; resume reverses it. Nothing is refunded.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 10, windowMs: 60_000, bucket: 'admin-stripe-write' }))
  .post(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const body = await runAdminStripeWrite({
        req,
        id: req.query.id,
        action: 'billing.subscription.cancel_scheduled',
        summary: 'scheduled cancellation at period end',
        precheck: subscription => {
          assertLiveStripeRow(subscription);
          if (isScheduledToCancel(subscription)) throw new ConflictError('A cancellation is already scheduled.');
        },
        params: () => ({ cancel_at_period_end: true }),
        changes: cancelScheduleChanges,
      });
      return res.status(200).json(body);
    })
  );

export default handler;
