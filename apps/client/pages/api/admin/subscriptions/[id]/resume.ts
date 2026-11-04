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
        mutate: (stripe, { idempotencyKey, subscription, stripeSubscriptionId }) =>
          stripe.subscriptions.update(
            stripeSubscriptionId,
            // An empty cancel_at unsets a custom cancel date; only send it when one is set.
            { cancel_at_period_end: false, ...(subscription.cancelAt ? { cancel_at: '' } : {}) },
            { idempotencyKey }
          ),
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
