import { ApiKeyScope } from '@bike4mind/common';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ConflictError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import {
  SubscriptionOwnerType,
  SubscriptionSource,
  isCancellableSubscriptionStatus,
  resolveSubscriptionSource,
  type ISubscription,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  AdminCompChangeSchema,
  COMP_MAX_MONTHS_AHEAD,
  type AdminCompChange,
  type AdminCompChangeResponse,
} from '@client/app/utils/adminSubscriptionDetail';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Subscription, subscriptionRepository } from '@server/models/Subscription';
import { subscriptionPlanCatalog } from '@server/admin/subscriptionsList/adminSubscriptionsQuery';
import { toAdminSubscriptionRows, type SubscriptionDoc } from '@server/admin/subscriptionsList/listAdminSubscriptions';
import {
  denySelfAdminAction,
  isSelfOrImpersonator,
  parseAdminActionReason,
  recordAdminActionFromRequest,
} from '@server/utils/adminAudit';
import { sendToClient } from '@server/websocket/utils';
import { Resource } from 'sst';

type AuditTarget = Parameters<typeof recordAdminActionFromRequest>[1]['target'];
type AuditChange = { field: string; before: unknown; after: unknown };

type Mutation = {
  update: Partial<Pick<ISubscription, 'status' | 'canceledAt' | 'periodEndsAt'>>;
  summary: string;
  changes: AuditChange[];
};

const toIsoDay = (date: Date) => date.toISOString().slice(0, 10);

const latestAllowedEndsAt = (now: Date) => {
  const limit = new Date(now);
  limit.setUTCMonth(limit.getUTCMonth() + COMP_MAX_MONTHS_AHEAD);
  return limit;
};

const assertNonTerminal = (subscription: ISubscription) => {
  if (!isCancellableSubscriptionStatus(subscription.status)) {
    throw new ConflictError('This comp has already ended. Reopen it first.');
  }
};

const planSetEndsAt = (subscription: ISubscription, periodEndsAt: string, now: Date): Mutation => {
  assertNonTerminal(subscription);
  const next = new Date(periodEndsAt);
  if (next.getTime() > latestAllowedEndsAt(now).getTime()) {
    throw new BadRequestError(`The end date can be at most ${COMP_MAX_MONTHS_AHEAD} months from now.`);
  }
  const current = new Date(subscription.periodEndsAt);
  if (next.getTime() === current.getTime()) throw new BadRequestError('The end date is unchanged.');
  const verb = next.getTime() > current.getTime() ? 'extended comp to' : 'moved comp end date to';
  return {
    update: { periodEndsAt: next },
    summary: `${verb} ${toIsoDay(next)}`,
    changes: [{ field: 'periodEndsAt', before: current.toISOString(), after: next.toISOString() }],
  };
};

const planEnd = (subscription: ISubscription, now: Date): Mutation => {
  assertNonTerminal(subscription);
  return {
    update: { status: 'canceled', canceledAt: now },
    summary: 'ended comp',
    changes: [{ field: 'status', before: subscription.status, after: 'canceled' }],
  };
};

const planReopen = async (subscription: ISubscription): Promise<Mutation> => {
  // These checks run before the transaction and the guarded update does not re-check them, so two concurrent
  // admin reopens/grants for one owner could both pass; accepted because the window is admin-only and tiny.
  if (subscription.status !== 'canceled') throw new ConflictError('Only an ended comp can be reopened.');
  const live = await subscriptionRepository.findNonTerminalSubscriptionsByOwner(
    subscription.ownerType,
    subscription.ownerId
  );
  const others = live.filter(row => row.subscriptionId !== subscription.subscriptionId);
  if (others.some(row => resolveSubscriptionSource(row) === SubscriptionSource.AdminGrant)) {
    throw new ConflictError('This owner already has another live comp.');
  }
  // Mirrors the grant paths, which refuse a second active row on the same plan for user and org owners alike.
  if (others.some(row => row.status === 'active' && row.priceId === subscription.priceId)) {
    throw new ConflictError('This owner already has an active subscription on the same plan.');
  }
  return {
    update: { status: 'active', canceledAt: null },
    summary: 'reopened comp',
    changes: [{ field: 'status', before: subscription.status, after: 'active' }],
  };
};

const planMutation = (
  subscription: ISubscription,
  change: AdminCompChange,
  now: Date
): Mutation | Promise<Mutation> => {
  switch (change.action) {
    case 'setEndsAt':
      return planSetEndsAt(subscription, change.periodEndsAt, now);
    case 'end':
      return planEnd(subscription, now);
    case 'reopen':
      return planReopen(subscription);
  }
};

type OwnerContext = {
  target: AuditTarget;
  organizationId?: string;
  notifyUserId: string | null;
  actingUserId: string | null;
};

const resolveOwner = async (subscription: ISubscription): Promise<OwnerContext> => {
  if (subscription.ownerType === SubscriptionOwnerType.User) {
    const user = await userRepository.findById(subscription.ownerId);
    return {
      target: {
        kind: 'user',
        id: subscription.ownerId,
        displayName: user?.email ?? user?.username ?? subscription.ownerId,
      },
      notifyUserId: subscription.ownerId,
      actingUserId: subscription.ownerId,
    };
  }
  const organization = await organizationRepository.findById(subscription.ownerId);
  return {
    target: {
      kind: 'organization',
      id: subscription.ownerId,
      displayName: organization?.name ?? subscription.ownerId,
    },
    organizationId: subscription.ownerId,
    notifyUserId: organization?.userId ?? null,
    actingUserId: organization?.userId ?? null,
  };
};

const COMP_CHANGED_CONCURRENTLY_MESSAGE = 'This subscription changed; reload and try again.';

/**
 * Applies the update only if the row still holds the state the mutation was planned from, so a
 * concurrent change between the read and this write turns into a 409 instead of a lost update.
 */
const applyGuardedUpdate = async (
  id: string,
  subscription: ISubscription,
  change: AdminCompChange,
  mutation: Mutation
) => {
  const filter: Record<string, unknown> = {
    _id: id,
    // findById hydrates the schema default source, so $exists only guards a raw legacy row (belt-and-braces).
    source: subscription.source ?? { $exists: false },
    subscriptionId: subscription.subscriptionId,
    status: subscription.status,
  };
  if (change.action === 'setEndsAt') filter.periodEndsAt = subscription.periodEndsAt;
  const updated = await Subscription.findOneAndUpdate(filter, { $set: mutation.update }, { new: true }).lean();
  if (!updated) throw new ConflictError(COMP_CHANGED_CONCURRENTLY_MESSAGE);
};

const readRow = async (id: string) => {
  const doc = await Subscription.findById(id).lean<SubscriptionDoc>();
  if (!doc) throw new NotFoundError('Subscription not found');
  const [row] = await toAdminSubscriptionRows([doc], subscriptionPlanCatalog());
  return row;
};

/**
 * POST /api/admin/subscriptions/[id]/comp: extend, shorten, end or reopen an admin-granted comp. Nothing
 * auto-expires a comp on periodEndsAt, so this is the only way one ends. Credits already granted are not reclaimed.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Unauthorized. Admin access required.');

    const parsed = AdminCompChangeSchema.safeParse(req.body);
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? 'Invalid request body');
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const { id } = req.query;
    const subscription = /^[0-9a-f]{24}$/i.test(id) ? await subscriptionRepository.findById(id) : null;
    if (!subscription) throw new NotFoundError('Subscription not found');
    if (resolveSubscriptionSource(subscription) !== SubscriptionSource.AdminGrant) {
      throw new ConflictError('Only comped subscriptions can be changed here.');
    }

    const owner = await resolveOwner(subscription);
    if (owner.actingUserId && isSelfOrImpersonator(req.user, owner.actingUserId)) {
      await denySelfAdminAction(req, {
        action: 'user.subscription.denied',
        attempted: 'billing.comp.changed',
        target: owner.target,
      });
    }

    const mutation = await planMutation(subscription, parsed.data, new Date());

    // The write and its strict audit commit together, so an audit failure rolls the change back.
    await withTransaction(async () => {
      await applyGuardedUpdate(id, subscription, parsed.data, mutation);
      await recordAdminActionFromRequest(req, {
        action: 'billing.comp.changed',
        target: owner.target,
        organizationId: owner.organizationId,
        summary: mutation.summary,
        reason,
        changes: mutation.changes,
        details: {
          subscriptionId: subscription.subscriptionId,
          subscriptionRecordId: id,
          change: parsed.data.action,
        },
      });
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
      req.logger.error('Failed to notify clients after comp change', error);
    }

    const body: AdminCompChangeResponse = { subscription: await readRow(id) };
    return res.status(200).json(body);
  })
);

export default handler;
