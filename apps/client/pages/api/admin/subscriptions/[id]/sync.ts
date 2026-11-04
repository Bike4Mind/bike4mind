import { ApiKeyScope } from '@bike4mind/common';
import { billingMismatchRepository, organizationRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { stripe } from '@bike4mind/server-utils/integrations/stripe/stripe';
import {
  SubscriptionSource,
  resolveSubscriptionSource,
  type ISubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import { stripeSubscriptionRowFields } from '@bike4mind/server-utils/lib/subscriptions/stripeMirror';
import { Subscription, subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { ConflictError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import {
  AdminSubscriptionSyncSchema,
  type AdminSubscriptionSyncChange,
  type AdminSubscriptionSyncPreview,
  type AdminSubscriptionSyncResponse,
} from '@client/app/utils/adminSubscriptionDetail';
import { resolveSubscriptionOwner } from '@server/admin/subscriptionDetail/resolveSubscriptionOwner';
import { subscriptionPlanCatalog } from '@server/admin/subscriptionsList/adminSubscriptionsQuery';
import { toAdminSubscriptionRows, type SubscriptionDoc } from '@server/admin/subscriptionsList/listAdminSubscriptions';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { applyStripeSubscriptionState } from '@server/subscriptions/applyStripeSubscriptionState';
import { stripeSyncChanges } from '@server/subscriptions/stripeSyncChanges';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import { Resource } from 'sst';

type StripeSubscription = Awaited<ReturnType<typeof stripe.subscriptions.retrieve>>;

const isResourceMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'resource_missing';

const loadStripeRow = async (id: string): Promise<ISubscription & { updatedAt?: Date }> => {
  const row = /^[0-9a-f]{24}$/i.test(id) ? await subscriptionRepository.findById(id) : null;
  if (!row) throw new NotFoundError('Subscription not found');
  if (resolveSubscriptionSource(row) !== SubscriptionSource.Stripe || !row.subscriptionId) {
    throw new BadRequestError('Only subscriptions billed through Stripe can be synced.');
  }
  return row;
};

/** The live Stripe subscription, or null when Stripe has none (the row is then treated as canceled). */
const retrieveStripe = async (subscriptionId: string): Promise<StripeSubscription | null> => {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (error) {
    if (isResourceMissing(error)) return null;
    throw error;
  }
};

const readRow = async (id: string) => {
  const doc = await Subscription.findById(id).lean<SubscriptionDoc>();
  if (!doc) throw new NotFoundError('Subscription not found');
  const [row] = await toAdminSubscriptionRows([doc], subscriptionPlanCatalog());
  return row;
};

const canceledChanges = (row: ISubscription, now: Date): AdminSubscriptionSyncChange[] =>
  row.status === 'canceled'
    ? []
    : [
        { field: 'status', before: row.status, after: 'canceled' },
        { field: 'canceledAt', before: row.canceledAt?.toISOString() ?? null, after: now.toISOString() },
      ];

const previewChanges = async (
  row: ISubscription,
  stripeSub: StripeSubscription | null,
  now: Date
): Promise<AdminSubscriptionSyncChange[]> => {
  if (!stripeSub) {
    return canceledChanges(row, now);
  }
  const customerId = typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id;
  const organization =
    row.ownerType === 'Organization' ? await organizationRepository.findByStripeCustomerId(customerId) : null;
  return stripeSyncChanges({
    before: row,
    after: stripeSubscriptionRowFields(stripeSub, now),
    seats: organization
      ? { organizationId: organization.id, before: organization.seats, after: stripeSub.items.data[0].quantity ?? 1 }
      : undefined,
  });
};

/**
 * GET previews Sync from Stripe (a live Stripe read, nothing written); POST applies it: the row and an
 * organization's seats take Stripe's values. Mongo-only, so Stripe is never written to.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(rateLimit({ limit: 10, windowMs: 60_000, bucket: 'admin-subscription-sync' }))
  .get(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');
      const row = await loadStripeRow(req.query.id);
      const stripeSub = await retrieveStripe(row.subscriptionId as string);
      const body: AdminSubscriptionSyncPreview = {
        changes: await previewChanges(row, stripeSub, new Date()),
        stripeMissing: stripeSub === null,
        stripeStatus: stripeSub?.status ?? null,
        updatedAt: (row.updatedAt ?? new Date(0)).toISOString(),
      };
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json(body);
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

      const parsed = AdminSubscriptionSyncSchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
      const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

      const { id } = req.query;
      const row = await loadStripeRow(id);
      const subscriptionId = row.subscriptionId as string;

      const owner = await resolveSubscriptionOwner(row);
      if (owner.actingUserId && isSelfOrImpersonator(req.user, owner.actingUserId)) {
        await denySelfAdminAction(req, {
          action: 'user.subscription.denied',
          attempted: 'billing.subscription.synced',
          target: owner.target,
        });
      }

      if ((row.updatedAt ?? new Date(0)).getTime() !== new Date(parsed.data.expectedUpdatedAt).getTime()) {
        throw new ConflictError('This subscription changed; reload and try again.');
      }

      // Read before the transaction opens: no network call holds it.
      const stripeSub = await retrieveStripe(subscriptionId);
      const now = new Date();

      // The write and its strict audit commit together, so an audit failure rolls the sync back.
      const changes = await withTransaction(async () => {
        let before: ISubscription | null;
        let diff: AdminSubscriptionSyncChange[];
        if (stripeSub) {
          const applied = await applyStripeSubscriptionState(stripeSub, {
            ownerType: row.ownerType,
            logger: req.logger,
            expectedUpdatedAt: row.updatedAt,
          });
          before = applied.before;
          diff = stripeSyncChanges(applied);
        } else {
          // Stripe has no such subscription: the same write as customer.subscription.deleted. A row that is
          // already canceled keeps its canceledAt, so nothing is written.
          before =
            row.status === 'canceled'
              ? row
              : await subscriptionRepository.updateByStripeSubscriptionIdReturningBefore(
                  subscriptionId,
                  { status: 'canceled', canceledAt: now },
                  row.updatedAt
                );
          diff = before ? canceledChanges(before, now) : [];
        }
        if (!before) throw new ConflictError('This subscription changed; reload and try again.');
        await recordAdminActionFromRequest(req, {
          action: 'billing.subscription.synced',
          target: owner.target,
          organizationId: owner.organizationId,
          summary: stripeSub
            ? 'synced subscription from Stripe'
            : 'synced subscription from Stripe (gone from Stripe, marked canceled)',
          reason,
          changes: diff.map(({ field, before, after }) => ({ field, before, after })),
          details: { subscriptionId, subscriptionRecordId: id, stripeMissing: stripeSub === null },
        });
        await billingMismatchRepository.resolveForSubscription(id, 'sync', now);
        return diff;
      });

      try {
        if (owner.notifyUserId) {
          await sendToClient(owner.notifyUserId, Resource.websocket.managementEndpoint, {
            action: 'invalidate_query',
            queryKey: ['subscriptions'],
          });
        }
        if (owner.actingUserId) {
          await sendToClient(owner.actingUserId, Resource.websocket.managementEndpoint, {
            action: 'invalidate_query',
            queryKey: ['admin', 'user-subscriptions', owner.actingUserId],
          });
        }
      } catch (error) {
        req.logger.error('Failed to notify clients after subscription sync', error);
      }

      const body: AdminSubscriptionSyncResponse = { subscription: await readRow(id), changes };
      return res.status(200).json(body);
    })
  );

export default handler;
