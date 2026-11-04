import { ApiKeyScope } from '@bike4mind/common';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import {
  SubscriptionSource,
  isCancellableSubscriptionStatus,
  resolveSubscriptionSource,
  type ISubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { runAdminStripeWrite } from '@server/admin/stripeWrite/adminStripeWrite';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';

const isoOrNull = (date: Date | null | undefined) => (date ? new Date(date).toISOString() : null);

const isScheduledToCancel = (subscription: ISubscription) =>
  Boolean(subscription.cancelAtPeriodEnd || subscription.cancelAt);

const assertLiveStripeRow = (subscription: ISubscription) => {
  if (resolveSubscriptionSource(subscription) !== SubscriptionSource.Stripe) {
    throw new ConflictError('Only subscriptions billed through Stripe can be changed here.');
  }
  if (!isCancellableSubscriptionStatus(subscription.status)) {
    throw new ConflictError('This subscription has already ended.');
  }
};

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
        mutate: (stripe, { idempotencyKey, subscription, stripeSubscriptionId }) =>
          stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true }, { idempotencyKey }),
        changes: (before, after) => [
          { field: 'cancelAtPeriodEnd', before: Boolean(before.cancelAtPeriodEnd), after: after.cancel_at_period_end },
          {
            field: 'cancelAt',
            before: isoOrNull(before.cancelAt),
            after: after.cancel_at ? new Date(after.cancel_at * 1000).toISOString() : null,
          },
        ],
      });
      return res.status(200).json(body);
    })
  );

export default handler;
